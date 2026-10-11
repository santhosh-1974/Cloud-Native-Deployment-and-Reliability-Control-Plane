# Controller Persistence Schema Design

**Status:** Revised for review (Phase 1, Step 5)  
**Scope:** Schema and persistence design only. No implementation code or migrations applied yet.  
**Purpose:** Define the PostgreSQL schema required to support the controller state machine, safety invariants, and recovery protocol approved in `CONTROLLER_STATE_MACHINE_DESIGN.md` and `ARCHITECTURE.md`.

---

## 1. Repository Baseline and Migration Context

The repository contains an existing baseline migration at:
`controller/prisma/migrations/20261009135031_init/migration.sql`

This tracked migration is the immutable baseline for this proposal. Its recovered
SHA-256 is `05f0ff051e15df86b6991f4cd5a013f7e8c6d1c7d34556e486217e038fef9397`.
Do not edit, replace, squash, or reapply it to the existing database. The
proposed delta is a future second migration only and remains unapproved.

This migration defines five core domain tables and four enums:
- **Enums:** `DeploymentStatus`, `StageStatus`, `EvaluationResult`, `DeploymentEventType`
- **Tables:** `applications`, `deployments`, `deployment_stages`, `health_evaluations`, `deployment_events`

### 1.1 Baseline DDL Summary (from `20261009135031_init`)

```sql
-- Existing Enums
CREATE TYPE "public"."DeploymentStatus" AS ENUM (
    'PENDING', 'DEPLOYING', 'CANARY', 'VALIDATING', 'PROMOTING',
    'SUCCEEDED', 'CANARY_FAILED', 'ROLLING_BACK', 'ROLLED_BACK', 'FAILED'
);
CREATE TYPE "public"."StageStatus" AS ENUM (
    'UNEVALUATED', 'INTENT_RECORDED', 'APPLYING', 'APPLIED',
    'VALIDATING', 'PASSED', 'FAILED'
);
CREATE TYPE "public"."EvaluationResult" AS ENUM ('PASS', 'FAIL', 'INDETERMINATE');
CREATE TYPE "public"."DeploymentEventType" AS ENUM (
    'DEPLOYMENT_CREATED', 'DEPLOYMENT_STARTED', 'STAGE_INTENT_RECORDED',
    'TRAFFIC_APPLY_STARTED', 'TRAFFIC_APPLIED', 'TRAFFIC_VERIFIED',
    'HEALTH_VALIDATION_STARTED', 'HEALTH_VALIDATION_PASSED', 'HEALTH_VALIDATION_FAILED',
    'PROMOTION_STARTED', 'ROLLBACK_STARTED', 'ROLLBACK_VERIFIED',
    'DEPLOYMENT_SUCCEEDED', 'DEPLOYMENT_FAILED', 'DEPLOYMENT_ROLLED_BACK'
);

-- Existing Tables Summary
-- applications: id (TEXT PK), name (TEXT UNIQUE), config (JSONB), created_at, updated_at
-- deployments: id (TEXT PK), application_id (FK), request_identity (TEXT UNIQUE), target_image,
--              stable_image, desired_replicas, port, strategy (JSONB), status (DeploymentStatus),
--              current_stage_index, revision (INT DEFAULT 0), rollback_reason, rollback_outcome,
--              created_at, updated_at, completed_at
-- deployment_stages: id (TEXT PK), deployment_id (FK), stage_index, desired_canary_pct,
--                    desired_stable_pct, applied_canary_pct, applied_stable_pct,
--                    observed_canary_pct, observed_stable_pct, status (StageStatus),
--                    operation_id, operation_revision, apply_attempt, validation_started_at,
--                    validation_ended_at, completed_at, failure_reason, created_at, updated_at
-- health_evaluations: id (TEXT PK), deployment_id (FK), stage_id (FK), deployment_revision,
--                     window_start, window_end, result (EvaluationResult NOT NULL), is_fresh,
--                     failure_reason, observations (JSONB), created_at, updated_at
-- deployment_events: id (TEXT PK), deployment_id (FK), event_type (DeploymentEventType),
--                    payload (JSONB), occurred_at
```

### 1.2 Proposed Migration Boundary & Existing-Data Precondition

- **Migration Directory:** Standard 14-digit Prisma timestamp format: `20261010120000_controller_persistence`.
- **Comprehensive Existing-Data Precondition:**  
  The migration adds columns (`attempt_id`, `coordinator_epoch`, `target_image`) as `NOT NULL` without defaults to preserve semantic integrity, and adds columns to `deployments` and `deployment_stages`.  
  It must not invent synthetic history or fake attempt IDs for existing rows.  
  Therefore, before applying `20261010120000_controller_persistence`, the migration verifies that **all affected baseline tables** are empty:
  ```sql
  DO $$
  BEGIN
      IF EXISTS (SELECT 1 FROM "public"."health_evaluations" LIMIT 1) OR
         EXISTS (SELECT 1 FROM "public"."deployment_stages" LIMIT 1) OR
         EXISTS (SELECT 1 FROM "public"."deployments" LIMIT 1) OR
         EXISTS (SELECT 1 FROM "public"."applications" LIMIT 1) OR
         EXISTS (SELECT 1 FROM "public"."deployment_events" LIMIT 1) THEN
          RAISE EXCEPTION 'Precondition failed: baseline tables must be empty in the explicitly selected disposable migration-verification database.';
      END IF;
  END $$;
  ```
  This precondition applies only to an explicitly selected disposable target during a future migration rehearsal. It is not permission to clean, migrate, or test against the existing Compose database. A populated environment requires a separately reviewed migration and backfill plan; Appendix A does not authorize synthetic history.

---

## 2. Core Architectural Principles

1. **PostgreSQL as Authoritative Source of Truth:** All deployment lifecycle states, stage substates, coordinator leases, and fencing epochs reside durably in PostgreSQL. Kubernetes resources and AWS ALB listener rules are external projections reconciled from PostgreSQL.
2. **No Redis Dependency:** All distributed coordination, fencing, and serialized transitions are implemented using PostgreSQL row locks (`SELECT FOR UPDATE`), conditional updates, and lease timestamps.
3. **Wall-Clock Timestamping (`clock_timestamp()`):**  
   `CURRENT_TIMESTAMP` returns the start time of the PostgreSQL transaction. In a transaction that waits for a lock (e.g. `SELECT FOR UPDATE` on `coordinator`), `CURRENT_TIMESTAMP` can be seconds old before the lock is granted. To guarantee lease validity at the exact moment authorization is evaluated, **all lease checks, renewals, acquisitions, and mutation guards MUST use `clock_timestamp()`**, not `CURRENT_TIMESTAMP`.
4. **Strict Transaction Boundaries for External Operations (Three-Phase Protocol):**  
   **A database transaction and coordinator row lock MUST NEVER be held across Kubernetes or AWS network calls.**  
   External operations follow a strict three-phase lifecycle:
   - **Phase 1 (Pre-operation DB Transaction):** Acquire locks in the defined order, revalidate owner/epoch/expiry after all locks are held, require remaining lease to exceed the configured operation timeout, persist intent, revalidate authorization immediately before commit, and commit to release locks. Timeout values are deployment configuration, not schema defaults.
   - **Phase 2 (External Network Call):** Call Kubernetes API or AWS ELBv2 API with optimistic concurrency tokens (e.g., `resourceVersion`). Absolutely **NO** database transaction or lock is held during this network call.
   - **Phase 3 (Post-operation DB Transaction):** Open a fresh transaction, acquire locks in the same order, revalidate lease/epoch after lock acquisition and immediately before commit, and conditionally acknowledge the operation. If ownership is stale or the lease expires, roll back all state and event writes.
   - *Limitation acknowledged:* A PostgreSQL lock cannot recall a network packet already in flight. Fencing occurs at Phase 3 when acknowledging state.
5. **Strict Separation of Traffic Tiers:**
   - **Desired Traffic:** Intent persisted in `deployment_stages` (`desired_canary_pct`, `desired_stable_pct`) and logged as `DESIRED` in `traffic_observations`.
   - **Applied Traffic:** Kubernetes Ingress configuration written and acknowledged (`applied_canary_pct`, `applied_stable_pct`, `ingress_resource_version`).
   - **Observed Traffic:** AWS ALB data-plane state confirmed via a two-read stabilized `DescribeRules` verification (`observed_canary_pct`, `observed_stable_pct`, `listener_rule_arn`, `last_observed_at`).
6. **Configured Routing Weights vs. Live Traffic Telemetry:**  
   ALB listener-rule forward weights govern connection-distribution configuration at the ALB layer. They verify that the routing configuration is applied and stable; they do not guarantee real-time request counts across targets (which is the domain of Prometheus telemetry in health monitoring).
7. **Independent Traffic Safety Classification:** `deployments.traffic_safety` tracks whether live user traffic is exposed to target versions (`NOT_EXPOSED`, `EXPOSED`, `VERIFIED_STABLE`, `UNKNOWN`). It is never derived solely from lifecycle state.
8. **Monotonic Epoch Fencing:** PostgreSQL is authoritative for coordinator owner, lease expiry, and epoch. Every acquisition after an expired or unowned lease increments the epoch, even if the owner identifier is reused; renewal does not. Every state-changing transaction rechecks owner, epoch, and expiry after obtaining its locks and immediately before commit.
9. **Separate but Serialized Health Result Acceptance and Lifecycle Transitions:**  
   Result acceptance and lifecycle consumption remain separate transactions. Both acquire the coordinator row and then the same deployment row before touching attempt state. This serializes them and ensures predicates observe current deployment status and revision.
10. **Guarded Updates with Mandatory Affected-Row Assertion:**  
   Every state update must conditionally assert expected revisions, substates, and epochs. If `affected_rows != 1`, the transaction MUST ROLLBACK immediately. Dependent inserts (events, observations) must never commit if the preceding update failed.

---

## 3. Schema Delta: Second Migration Specification (`20261010120000_controller_persistence`)

### 3.1 New Enums

```sql
-- Traffic safety classification
CREATE TYPE "public"."TrafficSafety" AS ENUM (
    'NOT_EXPOSED',     -- Verified 0% target traffic before rollout
    'EXPOSED',         -- Target traffic > 0% active on ALB (or 100% on success)
    'UNKNOWN',         -- Conservative default when observation is stale, ambiguous, or missing
    'VERIFIED_STABLE'  -- Post-rollback verified: 100% stable / 0% target on ALB
);

-- Health evaluation attempt completion state (orthogonal to result)
CREATE TYPE "public"."EvaluationCompletion" AS ENUM (
    'RUNNING',         -- In-flight observation window
    'COMPLETE',        -- Window closed, signals evaluated, result recorded
    'INCOMPLETE'       -- Abandoned due to crash, epoch change, or revision change
);

-- Traffic observation record type
CREATE TYPE "public"."TrafficObservationType" AS ENUM (
    'DESIRED',         -- PostgreSQL stage intent
    'APPLIED',         -- Acknowledged Kubernetes Ingress spec
    'OBSERVED'         -- Verified AWS ALB DescribeRules read
);
```

---

### 3.2 Table Alterations

#### 1. Alter `health_evaluations` (Resolving Result Nullability & Single-Running Invariant)

```sql
-- Comprehensive precondition: all baseline tables must be empty
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "public"."health_evaluations" LIMIT 1) OR
       EXISTS (SELECT 1 FROM "public"."deployment_stages" LIMIT 1) OR
       EXISTS (SELECT 1 FROM "public"."deployments" LIMIT 1) OR
       EXISTS (SELECT 1 FROM "public"."applications" LIMIT 1) OR
       EXISTS (SELECT 1 FROM "public"."deployment_events" LIMIT 1) THEN
        RAISE EXCEPTION 'Precondition failed: baseline tables must be empty before applying migration 20261010120000_controller_persistence';
    END IF;
END $$;

-- Make result nullable for running/incomplete attempts
ALTER TABLE "public"."health_evaluations"
    ALTER COLUMN "result" DROP NOT NULL;

-- Add attempt tracking columns
ALTER TABLE "public"."health_evaluations"
    ADD COLUMN "attempt_id"         TEXT NOT NULL,
    ADD COLUMN "coordinator_epoch"  INTEGER NOT NULL,
    ADD COLUMN "completion"         "public"."EvaluationCompletion" NOT NULL DEFAULT 'RUNNING',
    ADD COLUMN "completed_at"       TIMESTAMPTZ(3),
    ADD COLUMN "abandonment_reason" TEXT,
    ADD COLUMN "target_image"       TEXT NOT NULL,
    ADD COLUMN "consumed_at"        TIMESTAMPTZ(3),
    ADD COLUMN "consumed_by_revision" INTEGER;

-- Strict database CHECK constraint defining permitted completion/result/timestamp/reason states:
-- 1. RUNNING: result IS NULL, completed_at IS NULL, abandonment_reason IS NULL
-- 2. COMPLETE: result IS NOT NULL, completed_at IS NOT NULL, abandonment_reason IS NULL
-- 3. INCOMPLETE: result IS NULL, completed_at IS NOT NULL, abandonment_reason IS NOT NULL
ALTER TABLE "public"."health_evaluations"
    ADD CONSTRAINT "chk_health_eval_completion_state"
    CHECK (
        ("completion" = 'RUNNING'    AND "result" IS NULL     AND "completed_at" IS NULL     AND "abandonment_reason" IS NULL) OR
        ("completion" = 'COMPLETE'   AND "result" IS NOT NULL AND "completed_at" IS NOT NULL AND "abandonment_reason" IS NULL) OR
        ("completion" = 'INCOMPLETE' AND "result" IS NULL     AND "completed_at" IS NOT NULL AND "abandonment_reason" IS NOT NULL)
    );

ALTER TABLE "public"."health_evaluations"
    ADD CONSTRAINT "chk_health_eval_consumption_pair"
    CHECK (("consumed_at" IS NULL AND "consumed_by_revision" IS NULL)
        OR ("completion" = 'COMPLETE' AND "consumed_at" IS NOT NULL
        AND "consumed_by_revision" IS NOT NULL));

-- Unique constraint: exactly one attempt_id per stage per deployment
CREATE UNIQUE INDEX "uq_health_evals_attempt"
    ON "public"."health_evaluations"("deployment_id", "stage_id", "attempt_id");

-- PARTIAL UNIQUE INDEX: Guarantees at most ONE attempt can be RUNNING for a given stage/revision
CREATE UNIQUE INDEX "uq_health_evals_single_running_attempt"
    ON "public"."health_evaluations"("deployment_id", "stage_id", "deployment_revision")
    WHERE "completion" = 'RUNNING';

-- Index for epoch-based abandonment queries
CREATE INDEX "idx_health_evals_by_epoch_completion"
    ON "public"."health_evaluations"("coordinator_epoch", "completion");

-- Index for stage-level active evaluation lookups
CREATE INDEX "idx_health_evals_by_stage_completion"
    ON "public"."health_evaluations"("deployment_id", "stage_id", "completion");

-- Bind the stage foreign key to the same deployment. The baseline has separate
-- deployment_id and stage_id foreign keys, which alone permit a mismatched pair.
ALTER TABLE "public"."deployment_stages"
    ADD CONSTRAINT "uq_deployment_stages_deployment_id_id"
    UNIQUE ("deployment_id", "id");
ALTER TABLE "public"."health_evaluations"
    ADD CONSTRAINT "health_evaluations_deployment_stage_fkey"
    FOREIGN KEY ("deployment_id", "stage_id")
    REFERENCES "public"."deployment_stages"("deployment_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
```

#### 2. Alter `deployments` (Adding Traffic Safety State)

```sql
ALTER TABLE "public"."deployments"
    ADD COLUMN "traffic_safety"             "public"."TrafficSafety" NOT NULL DEFAULT 'UNKNOWN',
    ADD COLUMN "traffic_observed_at"        TIMESTAMPTZ(3),
    ADD COLUMN "traffic_observation_source" TEXT;

ALTER TABLE "public"."deployments"
    ADD CONSTRAINT "chk_deployment_traffic_safety_status"
    CHECK (("status" = 'ROLLED_BACK' AND "traffic_safety" = 'VERIFIED_STABLE')
        OR ("status" <> 'ROLLED_BACK' AND "traffic_safety" <> 'VERIFIED_STABLE')),
    ADD CONSTRAINT "chk_deployment_success_traffic_safety"
    CHECK ("status" <> 'SUCCEEDED' OR "traffic_safety" = 'EXPOSED');
```

#### 3. Alter `deployment_stages` (Adding Kubernetes & ALB Fencing Metadata)

```sql
ALTER TABLE "public"."deployment_stages"
    ADD COLUMN "ingress_uid"              TEXT,
    ADD COLUMN "ingress_resource_version" TEXT,
    ADD COLUMN "ingress_generation"       INTEGER,
    ADD COLUMN "listener_rule_arn"        TEXT,
    ADD COLUMN "stable_target_group_arn"  TEXT,
    ADD COLUMN "target_target_group_arn"  TEXT,
    ADD COLUMN "last_observed_at"         TIMESTAMPTZ(3);

ALTER TABLE "public"."deployment_stages"
    ADD CONSTRAINT "chk_stage_desired_weights"
    CHECK ("desired_canary_pct" BETWEEN 0 AND 100
       AND "desired_stable_pct" BETWEEN 0 AND 100
       AND "desired_canary_pct" + "desired_stable_pct" = 100),
    ADD CONSTRAINT "chk_stage_applied_weights"
    CHECK (("applied_canary_pct" IS NULL AND "applied_stable_pct" IS NULL)
        OR ("applied_canary_pct" IS NOT NULL AND "applied_stable_pct" IS NOT NULL
        AND "applied_canary_pct" BETWEEN 0 AND 100
       AND "applied_stable_pct" BETWEEN 0 AND 100
       AND "applied_canary_pct" + "applied_stable_pct" = 100)),
    ADD CONSTRAINT "chk_stage_observed_weights"
    CHECK (("observed_canary_pct" IS NULL AND "observed_stable_pct" IS NULL)
        OR ("observed_canary_pct" IS NOT NULL AND "observed_stable_pct" IS NOT NULL
        AND "observed_canary_pct" BETWEEN 0 AND 100
       AND "observed_stable_pct" BETWEEN 0 AND 100
       AND "observed_canary_pct" + "observed_stable_pct" = 100));

CREATE INDEX "idx_stages_by_ingress"
    ON "public"."deployment_stages"("ingress_uid", "ingress_resource_version");

CREATE INDEX "idx_stages_by_listener_rule"
    ON "public"."deployment_stages"("listener_rule_arn");
```

---

### 3.3 New Tables

#### 1. Table `coordinator` (Singleton Lease & Epoch Fencing)

```sql
CREATE TABLE "public"."coordinator" (
    "id"               TEXT         NOT NULL,
    "owner_id"         TEXT,
    "epoch"            INTEGER      NOT NULL DEFAULT 0,
    "lease_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "renewed_at"       TIMESTAMPTZ(3) NOT NULL,
    "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "coordinator_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_coordinator_singleton" CHECK ("id" = 'singleton')
);

-- Seed singleton record: lease_expires_at at Unix epoch allows immediate takeover
INSERT INTO "public"."coordinator" (
    "id", "owner_id", "epoch", "lease_expires_at", "renewed_at", "created_at", "updated_at"
) VALUES (
    'singleton', NULL, 0, '1970-01-01 00:00:00.000', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
```

#### 2. Table `traffic_observations` (Append-Oriented Observation Log)

```sql
CREATE TABLE "public"."traffic_observations" (
    "id"                       TEXT         NOT NULL,
    "deployment_id"            TEXT         NOT NULL,
    "stage_id"                 TEXT,
    "deployment_revision"      INTEGER      NOT NULL,
    "coordinator_epoch"        INTEGER      NOT NULL,
    "observation_type"         "public"."TrafficObservationType" NOT NULL,
    "stable_weight_pct"        INTEGER,
    "target_weight_pct"        INTEGER,
    "ingress_uid"              TEXT,
    "ingress_resource_version" TEXT,
    "ingress_generation"       INTEGER,
    "listener_rule_arn"        TEXT,
    "target_group_arns"        JSONB,
    "is_fresh"                 BOOLEAN      NOT NULL DEFAULT true,
    "observed_at"              TIMESTAMPTZ(3) NOT NULL,
    "created_at"               TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "traffic_observations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "traffic_observations_deployment_id_fkey"
        FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "traffic_observations_stage_id_fkey"
        FOREIGN KEY ("stage_id") REFERENCES "public"."deployment_stages"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "chk_traffic_observation_weights"
        CHECK (("stable_weight_pct" IS NULL AND "target_weight_pct" IS NULL)
           OR ("stable_weight_pct" IS NOT NULL AND "target_weight_pct" IS NOT NULL
           AND "stable_weight_pct" BETWEEN 0 AND 100
           AND "target_weight_pct" BETWEEN 0 AND 100
           AND "stable_weight_pct" + "target_weight_pct" = 100))
);

CREATE INDEX "idx_traffic_observations_by_stage"
    ON "public"."traffic_observations"("deployment_id", "stage_id", "observed_at" DESC);

CREATE INDEX "idx_traffic_observations_by_revision"
    ON "public"."traffic_observations"("deployment_id", "deployment_revision", "observation_type");

CREATE INDEX "idx_traffic_observations_by_epoch"
    ON "public"."traffic_observations"("coordinator_epoch", "observation_type");
```

#### 3. Append-only event idempotency key

Health-result acceptance uses a stable key so its accepted-result event is unique even if a caller retries after losing the commit response. Multiple existing events remain valid because the added key is nullable.

```sql
ALTER TABLE "public"."deployment_events"
    ADD COLUMN "idempotency_key" TEXT;
CREATE UNIQUE INDEX "uq_deployment_events_idempotency_key"
    ON "public"."deployment_events"("idempotency_key");
```

---

## 4. Complete Updated Prisma Model Specification

When `20261010120000_controller_persistence` is applied, `controller/prisma/schema.prisma` will reflect the complete model:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

enum DeploymentStatus {
  PENDING
  DEPLOYING
  CANARY
  VALIDATING
  PROMOTING
  SUCCEEDED
  CANARY_FAILED
  ROLLING_BACK
  ROLLED_BACK
  FAILED
}

enum StageStatus {
  UNEVALUATED
  INTENT_RECORDED
  APPLYING
  APPLIED
  VALIDATING
  PASSED
  FAILED
}

enum EvaluationResult {
  PASS
  FAIL
  INDETERMINATE
}

enum EvaluationCompletion {
  RUNNING
  COMPLETE
  INCOMPLETE
}

enum TrafficSafety {
  NOT_EXPOSED
  EXPOSED
  UNKNOWN
  VERIFIED_STABLE
}

enum TrafficObservationType {
  DESIRED
  APPLIED
  OBSERVED
}

enum DeploymentEventType {
  DEPLOYMENT_CREATED
  DEPLOYMENT_STARTED
  STAGE_INTENT_RECORDED
  TRAFFIC_APPLY_STARTED
  TRAFFIC_APPLIED
  TRAFFIC_VERIFIED
  HEALTH_VALIDATION_STARTED
  HEALTH_VALIDATION_PASSED
  HEALTH_VALIDATION_FAILED
  PROMOTION_STARTED
  ROLLBACK_STARTED
  ROLLBACK_VERIFIED
  DEPLOYMENT_SUCCEEDED
  DEPLOYMENT_FAILED
  DEPLOYMENT_ROLLED_BACK
}

model Coordinator {
  id             String   @id
  ownerId        String?  @map("owner_id")
  epoch          Int      @default(0)
  leaseExpiresAt DateTime @db.Timestamptz(3) @map("lease_expires_at")
  renewedAt      DateTime @db.Timestamptz(3) @map("renewed_at")
  createdAt      DateTime @default(now()) @db.Timestamptz(3) @map("created_at")
  updatedAt      DateTime @updatedAt @db.Timestamptz(3) @map("updated_at")

  @@map("coordinator")
}

model Application {
  id          String       @id @default(uuid())
  name        String       @unique
  config      Json         @default("{}")
  createdAt   DateTime     @default(now()) @map("created_at")
  updatedAt   DateTime     @updatedAt @map("updated_at")
  deployments Deployment[]

  @@map("applications")
}

model Deployment {
  id                        String                @id @default(uuid())
  applicationId             String                @map("application_id")
  application               Application           @relation(fields: [applicationId], references: [id])
  requestIdentity           String                @unique @map("request_identity")
  targetImage               String                @map("target_image")
  stableImage               String?               @map("stable_image")
  desiredReplicas           Int                   @map("desired_replicas")
  port                      Int
  strategy                  Json
  status                    DeploymentStatus      @default(PENDING)
  currentStageIndex         Int?                  @map("current_stage_index")
  revision                  Int                   @default(0)
  rollbackReason            String?               @map("rollback_reason")
  rollbackOutcome           String?               @map("rollback_outcome")
  trafficSafety             TrafficSafety         @default(UNKNOWN) @map("traffic_safety")
  trafficObservedAt         DateTime?             @db.Timestamptz(3) @map("traffic_observed_at")
  trafficObservationSource  String?               @map("traffic_observation_source")
  createdAt                 DateTime              @default(now()) @map("created_at")
  updatedAt                 DateTime              @updatedAt @map("updated_at")
  completedAt               DateTime?             @map("completed_at")
  stages                    DeploymentStage[]
  healthEvaluations         HealthEvaluation[]
  events                    DeploymentEvent[]
  trafficObservations       TrafficObservation[]

  @@index([applicationId, status], map: "idx_deployments_by_app_status")
  @@index([applicationId, createdAt(sort: Desc)], map: "idx_deployments_by_app")
  @@map("deployments")
}

model DeploymentStage {
  id                     String               @id @default(uuid())
  deploymentId           String               @map("deployment_id")
  deployment             Deployment           @relation(fields: [deploymentId], references: [id])
  stageIndex             Int                  @map("stage_index")
  desiredCanaryPct       Int                  @map("desired_canary_pct")
  desiredStablePct       Int                  @map("desired_stable_pct")
  appliedCanaryPct       Int?                 @map("applied_canary_pct")
  appliedStablePct       Int?                 @map("applied_stable_pct")
  observedCanaryPct      Int?                 @map("observed_canary_pct")
  observedStablePct      Int?                 @map("observed_stable_pct")
  status                 StageStatus          @default(UNEVALUATED)
  operationId            String?              @map("operation_id")
  operationRevision      Int?                 @map("operation_revision")
  applyAttempt           Int                  @default(0) @map("apply_attempt")
  ingressUid             String?              @map("ingress_uid")
  ingressResourceVersion String?              @map("ingress_resource_version")
  ingressGeneration      Int?                 @map("ingress_generation")
  listenerRuleArn        String?              @map("listener_rule_arn")
  stableTargetGroupArn   String?              @map("stable_target_group_arn")
  targetTargetGroupArn   String?              @map("target_target_group_arn")
  lastObservedAt         DateTime?            @db.Timestamptz(3) @map("last_observed_at")
  validationStartedAt    DateTime?            @map("validation_started_at")
  validationEndedAt      DateTime?            @map("validation_ended_at")
  completedAt            DateTime?            @map("completed_at")
  failureReason          String?              @map("failure_reason")
  createdAt              DateTime             @default(now()) @map("created_at")
  updatedAt              DateTime             @updatedAt @map("updated_at")
  healthEvaluations      HealthEvaluation[]
  trafficObservations    TrafficObservation[]

  @@unique([deploymentId, stageIndex], map: "deployment_stages_deployment_id_stage_index_key")
  @@unique([deploymentId, id], map: "uq_deployment_stages_deployment_id_id")
  @@index([deploymentId, stageIndex], map: "idx_stages_by_deployment")
  @@index([ingressUid, ingressResourceVersion], map: "idx_stages_by_ingress")
  @@index([listenerRuleArn], map: "idx_stages_by_listener_rule")
  @@map("deployment_stages")
}

model HealthEvaluation {
  id                 String               @id @default(uuid())
  deploymentId       String               @map("deployment_id")
  deployment         Deployment           @relation(fields: [deploymentId], references: [id])
  stageId            String               @map("stage_id")
  stage              DeploymentStage      @relation(fields: [stageId], references: [id])
  attemptId          String               @map("attempt_id")
  coordinatorEpoch   Int                  @map("coordinator_epoch")
  deploymentRevision Int                  @map("deployment_revision")
  targetImage        String               @map("target_image")
  windowStart        DateTime             @map("window_start")
  windowEnd          DateTime?            @map("window_end")
  completion         EvaluationCompletion @default(RUNNING)
  result             EvaluationResult?
  isFresh            Boolean              @default(true) @map("is_fresh")
  failureReason      String?              @map("failure_reason")
  abandonmentReason  String?              @map("abandonment_reason")
  observations       Json                 @default("{}")
  completedAt        DateTime?            @db.Timestamptz(3) @map("completed_at")
  consumedAt         DateTime?            @db.Timestamptz(3) @map("consumed_at")
  consumedByRevision Int?                 @map("consumed_by_revision")
  createdAt          DateTime             @default(now()) @map("created_at")
  updatedAt          DateTime             @updatedAt @map("updated_at")

  @@unique([deploymentId, stageId, attemptId], map: "uq_health_evals_attempt")
  @@index([deploymentId, stageId, createdAt(sort: Desc)], map: "idx_health_evals_by_stage")
  @@index([deploymentId, deploymentRevision], map: "idx_health_evals_by_revision")
  @@index([coordinatorEpoch, completion], map: "idx_health_evals_by_epoch_completion")
  @@index([deploymentId, stageId, completion], map: "idx_health_evals_by_stage_completion")
  @@map("health_evaluations")
}

model TrafficObservation {
  id                     String                 @id @default(uuid())
  deploymentId           String                 @map("deployment_id")
  deployment             Deployment             @relation(fields: [deploymentId], references: [id])
  stageId                String?                @map("stage_id")
  stage                  DeploymentStage?       @relation(fields: [stageId], references: [id], onDelete: Restrict, onUpdate: Cascade)
  deploymentRevision     Int                    @map("deployment_revision")
  coordinatorEpoch       Int                    @map("coordinator_epoch")
  observationType        TrafficObservationType @map("observation_type")
  stableWeightPct        Int?                   @map("stable_weight_pct")
  targetWeightPct        Int?                   @map("target_weight_pct")
  ingressUid             String?                @map("ingress_uid")
  ingressResourceVersion String?                @map("ingress_resource_version")
  ingressGeneration      Int?                   @map("ingress_generation")
  listenerRuleArn        String?                @map("listener_rule_arn")
  targetGroupArns        Json?                  @map("target_group_arns")
  isFresh                Boolean                @default(true) @map("is_fresh")
  observedAt             DateTime               @db.Timestamptz(3) @map("observed_at")
  createdAt              DateTime               @default(now()) @db.Timestamptz(3) @map("created_at")

  @@index([deploymentId, stageId, observedAt(sort: Desc)], map: "idx_traffic_observations_by_stage")
  @@index([deploymentId, deploymentRevision, observationType], map: "idx_traffic_observations_by_revision")
  @@index([coordinatorEpoch, observationType], map: "idx_traffic_observations_by_epoch")
  @@map("traffic_observations")
}

model DeploymentEvent {
  id           String              @id @default(uuid())
  deploymentId String              @map("deployment_id")
  deployment   Deployment          @relation(fields: [deploymentId], references: [id])
  eventType    DeploymentEventType @map("event_type")
  idempotencyKey String?           @unique(map: "uq_deployment_events_idempotency_key") @map("idempotency_key")
  payload      Json                @default("{}")
  occurredAt   DateTime            @default(now()) @map("occurred_at")

  @@index([deploymentId, occurredAt], map: "idx_events_by_deployment")
  @@index([eventType, occurredAt(sort: Desc)], map: "idx_events_by_type")
  @@map("deployment_events")
}
```

### 4.1 Prisma-to-SQL Reconciliation (Prisma 6.16.2)

The Prisma model block is the logical model; the reviewed SQL migration is also
authoritative for database objects that Prisma 6.16.2 cannot express. Physical
names below must be used verbatim so schema diffs and operations can identify
the same objects.

| Required database object | Representation |
|---|---|
| Baseline unique indexes `applications_name_key`, `deployments_request_identity_key`, `deployment_stages_deployment_id_stage_index_key` | Prisma `@unique` / `@@unique(..., map: ...)` in the model block. |
| Baseline and new ordinary indexes (`idx_deployments_by_app_status`, `idx_deployments_by_app`, `idx_stages_by_deployment`, `idx_stages_by_ingress`, `idx_stages_by_listener_rule`, `idx_health_evals_by_stage`, `idx_health_evals_by_revision`, `idx_health_evals_by_epoch_completion`, `idx_health_evals_by_stage_completion`, `idx_traffic_observations_by_stage`, `idx_traffic_observations_by_revision`, `idx_traffic_observations_by_epoch`, `idx_events_by_deployment`, `idx_events_by_type`) | Prisma `@@index(..., map: ...)`. |
| `uq_health_evals_attempt` and `uq_deployment_stages_deployment_id_id` | Prisma `@@unique(..., map: ...)`. |
| `uq_deployment_events_idempotency_key` | Nullable Prisma `@unique(map: ...)`; PostgreSQL permits multiple NULLs while requiring non-NULL keys to be unique. |
| `uq_health_evals_single_running_attempt` | Required PostgreSQL partial unique index, created and retained by reviewed raw migration SQL: unique `(deployment_id, stage_id, deployment_revision)` where `completion = 'RUNNING'`. Prisma 6.16.2 has no schema representation for this predicate. It is intentionally absent from the Prisma block, not optional: migration review and disposable-database catalog checks must verify its exact name, columns, uniqueness, and predicate. Do not silently drop or regenerate it away. |
| Completion/result/timestamp/reason check; paired consumption fields check; weight range/sum checks; `coordinator.id = 'singleton'`; lifecycle/traffic-safety compatibility checks | Required named SQL `CHECK` constraints in the migration. Prisma 6.16.2 does not represent these checks in the model block; verify them directly in migration review and disposable PostgreSQL. |
| Health evaluation `(deployment_id, stage_id)` must reference the same deployment/stage pair | Required composite SQL foreign key plus its supporting unique key on `deployment_stages(deployment_id, id)`. The Prisma relation remains useful for client navigation; the composite integrity rule is an explicit SQL-only constraint in this Prisma version. |

No SQL object is inferred from a comment or a client-side selector name. `map`
names the physical index/constraint. Before approval, compare this inventory with
the complete DDL and ensure no required index or constraint is missing from both
representations.

---

## 5. Concurrency Protocols and Transaction Semantics

### 5.1 Transaction Boundaries & External Operation Lifecycle (The Three-Phase Protocol)

**Core Safety Invariant:** A PostgreSQL transaction and coordinator row lock **MUST NEVER be held across Kubernetes or AWS network calls**.

External operations adhere to a strict three-phase lifecycle. Lock order for every
state-changing transaction is coordinator row, deployment row, then affected stage
and evaluation rows. Revalidate owner, epoch, and expiry with `clock_timestamp()`
after every potentially blocking lock acquisition, immediately before each
conditional mutation, and as the last database statement before commit. If the
lease expires while waiting for a lock, roll back and restart authorization in a
fresh transaction; do not renew inside the blocked transaction. Keep the
transaction bounded and perform no application or external work after the final
authorization check.

The figure is illustrative; all timing labels in it are non-normative. Use the
configured operation timeout rule above, not the pictured example. The database
remains the authority.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ Phase 1: Pre-Operation Intent Persistence (Short DB Transaction, ~5ms)          │
│ - Lock coordinator row (SELECT FOR UPDATE)                                      │
│ - Validate owner, epoch, and lease_expires_at > clock_timestamp()                │
│ - Verify lease buffer: (lease_expires_at - clock_timestamp()) >= 5s             │
│ - Record intent in database (e.g. StageStatus = 'APPLYING', operation_id)       │
│ - COMMIT TRANSACTION IMMEDIATELY (releases coordinator row lock and connection) │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ Phase 2: External Side-Effect Execution (Outside Any DB Transaction)            │
│ - Execute Kubernetes Ingress API mutation or AWS ELBv2 DescribeRules read       │
│ - NO database connection or transaction is held open                            │
│ - Uses optimistic concurrency tokens (Kubernetes Ingress resourceVersion)       │
│ - Acknowledges: PostgreSQL cannot recall a network packet already in flight    │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ Phase 3: Post-Operation Acknowledgment (Fresh Short DB Transaction, ~5ms)       │
│ - Open NEW database transaction                                                 │
│ - Re-acquire coordinator row lock (SELECT FOR UPDATE)                           │
│ - Re-validate owner, epoch, and lease_expires_at > clock_timestamp()             │
│ - Conditionally acknowledge operation (e.g. StageStatus = 'APPLIED')            │
│ - Assert affected_rows == 1 (if lease lost or epoch changed, ROLLBACK)          │
│ - COMMIT TRANSACTION IMMEDIATELY                                                │
└─────────────────────────────────────────────────────────────────────────────────┘
```

The universal authorization prelude used in Phase 1 and Phase 3:

```sql
-- The Universal Controller Authorization Guard (executed in short DB transactions)
SELECT owner_id, epoch, lease_expires_at
FROM coordinator
WHERE id = 'singleton'
FOR UPDATE;

-- Evaluate in application code using clock_timestamp():
-- IF owner_id != $my_owner_id THEN ROLLBACK; RAISE 'Not coordinator owner';
-- IF epoch != $my_epoch THEN ROLLBACK; RAISE 'Stale coordinator epoch';
-- IF lease_expires_at <= clock_timestamp() THEN ROLLBACK; RAISE 'Coordinator lease expired';
```

---

### 5.2 Coordinator Acquisition, Renewal, and Mutation Guard

#### 1. Acquisition Protocol (Process Startup / Takeover)

```sql
BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED;

-- Lock singleton row
SELECT owner_id, epoch, lease_expires_at
FROM coordinator
WHERE id = 'singleton'
FOR UPDATE;

-- Recheck after acquiring the coordinator row lock. A live lease belongs to
-- its current owner even if this request presents the same owner ID.
UPDATE coordinator
SET owner_id = $my_owner_id,
    epoch = epoch + 1,
    lease_expires_at = clock_timestamp() + ($lease_duration_sec * INTERVAL '1 second'),
    renewed_at = clock_timestamp(),
    updated_at = clock_timestamp()
WHERE id = 'singleton'
  AND (owner_id IS NULL OR lease_expires_at <= clock_timestamp())
RETURNING epoch, lease_expires_at;

-- Assert affected_rows == 1; if 0, another active instance holds the lease. ROLLBACK.
SELECT owner_id = $my_owner_id AND epoch = $new_epoch
       AND lease_expires_at > clock_timestamp() AS authorized
FROM coordinator WHERE id = 'singleton';
-- If false: ROLLBACK. This is the final check before COMMIT.
COMMIT;
```

#### 2. Lease Renewal Protocol (Heartbeat Loop)

```sql
BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED;

SELECT owner_id, epoch, lease_expires_at
FROM coordinator
WHERE id = 'singleton'
FOR UPDATE;

UPDATE coordinator
SET lease_expires_at = clock_timestamp() + ($lease_duration_sec * INTERVAL '1 second'),
    renewed_at = clock_timestamp(),
    updated_at = clock_timestamp()
WHERE id = 'singleton'
  AND owner_id = $my_owner_id
  AND epoch = $my_epoch
  AND lease_expires_at > clock_timestamp();

-- Assert affected_rows == 1. If 0, the lease expired or ownership transferred;
-- the controller process MUST immediately abdicate and cease mutations.
-- Recheck owner_id, epoch, and lease_expires_at > clock_timestamp() as the final
-- statement before commit. COMMIT only if the same owner/epoch remains authorized.
SELECT owner_id = $my_owner_id AND epoch = $my_epoch
       AND lease_expires_at > clock_timestamp() AS authorized
FROM coordinator
WHERE id = 'singleton';
-- If false: ROLLBACK.
COMMIT;
```

#### 3. Pre-Mutation Lease Guard

Before initiating any external write to Kubernetes or AWS ALB (Phase 1), the controller verifies:
```sql
SELECT (lease_expires_at - clock_timestamp()) >= ($mutation_timeout_sec * INTERVAL '1 second') AS lease_valid
FROM coordinator
WHERE id = 'singleton'
  AND owner_id = $my_owner_id
  AND epoch = $my_epoch;
```
If `lease_valid` is `false`, the controller triggers synchronous renewal before proceeding. If renewal fails, the operation is aborted.

---

### 5.3 Health Attempt Lifecycle Protocols

#### 1. Attempt Creation Transaction (Short DB Transaction)

```sql
BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED;

-- 1. Universal Authorization Guard
SELECT owner_id, epoch, lease_expires_at FROM coordinator WHERE id = 'singleton' FOR UPDATE;
-- Assert owner_id == $my_owner_id, epoch == $my_epoch, lease_expires_at > clock_timestamp()

-- 2. Lock and validate the exact active deployment stage
SELECT d.id
FROM deployments d
JOIN deployment_stages s ON s.deployment_id = d.id
  AND s.stage_index = d.current_stage_index
WHERE d.id = $deployment_id
  AND d.status = 'VALIDATING'
  AND d.revision = $expected_revision
  AND d.current_stage_index = $stage_index
  AND d.target_image = $target_image
  AND s.id = $stage_id
  AND s.status = 'VALIDATING'
FOR UPDATE OF d;
-- Assert exactly one row; recheck coordinator authorization after this lock.
-- Otherwise ROLLBACK.

-- 3. Insert new attempt with a planned window end bound to one DB timestamp.
-- Backed by partial unique index "uq_health_evals_single_running_attempt"
WITH bounds AS (SELECT clock_timestamp() AS window_start)
INSERT INTO health_evaluations (
    id, deployment_id, stage_id, attempt_id, coordinator_epoch,
    deployment_revision, target_image, window_start, window_end, completion,
    result, is_fresh, observations, created_at, updated_at
)
SELECT gen_random_uuid(), $deployment_id, $stage_id, $new_attempt_id, $my_epoch,
       $expected_revision, $target_image, bounds.window_start,
       bounds.window_start + ($window_duration_sec * INTERVAL '1 second'),
       'RUNNING', NULL, true, '{}', clock_timestamp(), clock_timestamp()
FROM bounds;

INSERT INTO deployment_events
    (id, deployment_id, event_type, idempotency_key, payload, occurred_at)
VALUES ($evaluation_id, $deployment_id, 'HEALTH_VALIDATION_STARTED',
        'health-start:' || $evaluation_id, $payload, clock_timestamp());

-- Recheck owner, epoch, and expiry immediately before commit.
SELECT owner_id = $my_owner_id AND epoch = $my_epoch
       AND lease_expires_at > clock_timestamp() AS authorized
FROM coordinator WHERE id = 'singleton';
-- If false: ROLLBACK.
COMMIT;
```

#### 2. Attempt Abandonment on Epoch Change (Takeover Recovery)

When a new coordinator acquires ownership with `new_epoch > old_epoch`, it first
commits the new lease/epoch. It then runs this short transaction before creating
new attempts. The coordinator lock prevents stale owners from accepting results
while this cleanup runs:
```sql
BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED;

SELECT owner_id, epoch, lease_expires_at
FROM coordinator WHERE id = 'singleton' FOR UPDATE;
-- Assert current owner/epoch equal the new owner/new_epoch and lease is live.

SELECT id FROM deployments
WHERE id IN (SELECT DISTINCT deployment_id FROM health_evaluations
             WHERE completion = 'RUNNING' AND coordinator_epoch < $new_epoch)
ORDER BY id
FOR UPDATE;
-- Lock deployments before the evaluation rows, matching the common lock order.

UPDATE health_evaluations
SET completion = 'INCOMPLETE',
    abandonment_reason = 'epoch_change',
    completed_at = clock_timestamp(),
    is_fresh = false,
    updated_at = clock_timestamp()
WHERE completion = 'RUNNING'
  AND coordinator_epoch < $new_epoch;

-- Recheck current coordinator authorization immediately before commit.
SELECT owner_id = $my_owner_id AND epoch = $new_epoch
       AND lease_expires_at > clock_timestamp() AS authorized
FROM coordinator WHERE id = 'singleton';
-- If false: ROLLBACK.
COMMIT;
```

#### 3. Same-epoch restart behavior

Coordinator IDs include a process-lifetime UUID. A process restart therefore
acquires a new epoch; it cannot silently resume the old owner's live lease.
Abandonment uses the epoch-change protocol above. If evaluation is later moved to
separate workers, same-epoch worker liveness and attempt ownership remain an open
architecture decision; do not abandon their attempts without durable liveness
evidence.

---

### 5.4 Atomic Health-Result Acceptance and Serialized Lifecycle Consumption

Result acceptance and lifecycle consumption are separate commits: accepting a
health result never changes deployment status. Both transactions use
`READ COMMITTED` and the same lock order: coordinator row, deployment row, then
stage/evaluation rows. The deployment row is the serialization point shared by
acceptance, abandonment, traffic-state persistence, and every lifecycle
transition. Do not use a read-then-write transaction without these row locks.

An attempt is identified by the immutable tuple
`(deployment_id, stage_id, stage_index, deployment_revision, target_image,
attempt_id, coordinator_epoch)`. The submitted tuple must equal the stored row,
the stage must belong to the deployment and be its current stage, and the
deployment target image must still match the snapshot. An attempt can be
consumed once; `consumed_at` and `consumed_by_revision` are written atomically
with the lifecycle transition.

#### Transaction A: accept one result, or replay/conflict without overwriting

The API normalizes the submitted result payload before opening the transaction.
For duplicate comparison, equality means the stored result, failure reason,
window end, and JSONB observations equal the normalized submitted values. JSONB
equality is used rather than serialized key order. The unique event key is
`health-result:<evaluation_id>`.

```sql
BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED;

-- Lock and authorize coordinator first.
SELECT owner_id, epoch, lease_expires_at FROM coordinator
WHERE id = 'singleton' FOR UPDATE;
-- Require owner_id = $my_owner_id, epoch = $my_epoch,
-- lease_expires_at > clock_timestamp(), and $attempt_epoch = $my_epoch.

-- Lock the shared deployment serialization row without filtering lifecycle
-- state yet, so an exact duplicate can replay after a later transition.
SELECT id, status, revision, current_stage_index, target_image
FROM deployments WHERE id = $deployment_id FOR UPDATE;
-- Require one row; recheck coordinator authorization after this lock.

SELECT id, stage_index, status, deployment_id
FROM deployment_stages WHERE id = $stage_id
  AND deployment_id = $deployment_id FOR UPDATE;
-- Require one row and recheck authorization.

SELECT * FROM health_evaluations
WHERE id = $evaluation_id
FOR UPDATE;
-- Recheck authorization after this lock. Compare every identity-tuple field.

-- If completion = 'COMPLETE':
--   If result, failure_reason, window_end, and observations equal the stored
--   values, this is an idempotent replay: make no writes, add no event, and
--   return the existing accepted result/event ID after the final auth check,
--   even if the deployment has since advanced. This branch is read-only.
--   If any value differs, ROLLBACK and return conflict (HTTP 409); never UPDATE.
-- If completion <> 'RUNNING', or the identity tuple is stale, ROLLBACK and reject.
-- For RUNNING only, require deployment status=VALIDATING, revision=$expected_revision,
-- current_stage_index=$stage_index, target_image=$target_image, stage_index=$stage_index,
-- and stage.status=VALIDATING before the conditional update. Require attempt_epoch=$my_epoch.

UPDATE health_evaluations
SET result = $result,
    completion = 'COMPLETE',
    completed_at = clock_timestamp(),
    failure_reason = $failure_reason,
    observations = $observations::jsonb,
    is_fresh = true,
    updated_at = clock_timestamp()
WHERE id = $evaluation_id
  AND deployment_id = $deployment_id
  AND stage_id = $stage_id
  AND attempt_id = $attempt_id
  AND deployment_revision = $expected_revision
  AND target_image = $target_image
  AND coordinator_epoch = $my_epoch
  AND completion = 'RUNNING'
  AND window_end = $window_end
  AND window_end <= clock_timestamp();
-- Require exactly one row. Zero rows means stale/superseded; ROLLBACK.

INSERT INTO deployment_events
    (id, deployment_id, event_type, idempotency_key, payload, occurred_at)
VALUES
    (gen_random_uuid(), $deployment_id,
     CASE WHEN $result = 'PASS' THEN 'HEALTH_VALIDATION_PASSED'
          ELSE 'HEALTH_VALIDATION_FAILED' END,
     'health-result:' || $evaluation_id, $event_payload, clock_timestamp());
-- This insert is in the same transaction as the guarded result update.

-- Final statement before commit: recheck current owner, epoch and expiry using
-- clock_timestamp(). If false, ROLLBACK the result and event together.
SELECT owner_id = $my_owner_id AND epoch = $my_epoch
       AND lease_expires_at > clock_timestamp() AS authorized
FROM coordinator WHERE id = 'singleton';
COMMIT;
```

Concurrent duplicate behavior is deterministic by lock order. The first
transaction to lock and commit the attempt accepts it. A waiting identical
request then sees `COMPLETE` and returns the stored result without another
event. A waiting conflicting request sees the same completed row and returns
409 without changing it. If the first transaction fails any predicate or loses
authorization, PostgreSQL rolls back both result and event; the next waiter may
then accept a valid result. A uniqueness violation on the event idempotency key
also rolls back the result update and is treated as an invariant failure to
reload and reconcile, never as permission to overwrite.

#### Transaction B: consume exactly one accepted attempt

```sql
BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED;

SELECT owner_id, epoch, lease_expires_at FROM coordinator
WHERE id = 'singleton' FOR UPDATE;
-- Require current owner/epoch and lease_expires_at > clock_timestamp().

SELECT id, status, revision, current_stage_index, target_image
FROM deployments WHERE id = $deployment_id FOR UPDATE;
-- Require one row, then recheck coordinator authorization.

SELECT id, stage_index, status, deployment_id
FROM deployment_stages WHERE id = $stage_id
  AND deployment_id = $deployment_id FOR UPDATE;
-- Require one row, then recheck authorization. For an unconsumed attempt,
-- require status VALIDATING, expected revision/current_stage_index, matching
-- target image, matching stage index, and stage status VALIDATING.

SELECT id, result, completion, is_fresh, consumed_at, consumed_by_revision
FROM health_evaluations
WHERE id = $evaluation_id
  AND deployment_id = $deployment_id
  AND stage_id = $stage_id
  AND attempt_id = $attempt_id
  AND deployment_revision = $expected_revision
  AND target_image = $target_image
  AND coordinator_epoch = $my_epoch
FOR UPDATE;
-- Require COMPLETE, fresh, window_end <= clock_timestamp(), matching tuple and
-- consumed_at IS NULL. Also require evaluation epoch = current coordinator epoch.
-- INCOMPLETE, old epoch, stale window, or changed deployment state cannot pass.
-- If consumed_at is already set, return the prior transition read-only only when
-- consumed_by_revision = deployments.revision and event key
-- 'lifecycle:' || evaluation_id exists; otherwise return conflict.

UPDATE health_evaluations
SET consumed_at = clock_timestamp(),
    consumed_by_revision = $expected_revision + 1,
    updated_at = clock_timestamp()
WHERE id = $evaluation_id
  AND deployment_id = $deployment_id
  AND stage_id = $stage_id
  AND attempt_id = $attempt_id
  AND completion = 'COMPLETE'
  AND is_fresh = true
  AND result = $result
  AND window_end <= clock_timestamp()
  AND consumed_at IS NULL
  AND deployment_revision = $expected_revision
  AND target_image = $target_image
  AND coordinator_epoch = $my_epoch;
-- Require exactly one row or ROLLBACK.

UPDATE deployments
SET status = $allowlisted_next_status,
    revision = revision + 1,
    rollback_reason = CASE WHEN $allowlisted_next_status = 'CANARY_FAILED'
                           THEN $failure_reason ELSE rollback_reason END,
    completed_at = CASE WHEN $allowlisted_next_status IN ('SUCCEEDED', 'ROLLED_BACK', 'FAILED')
                        THEN clock_timestamp() ELSE completed_at END,
    updated_at = clock_timestamp()
WHERE id = $deployment_id
  AND status = 'VALIDATING'
  AND revision = $expected_revision
  AND current_stage_index = $stage_index
  AND target_image = $target_image;
-- Require exactly one row. Otherwise ROLLBACK consumption and all events.

INSERT INTO deployment_events
    (id, deployment_id, event_type, idempotency_key, payload, occurred_at)
VALUES (gen_random_uuid(), $deployment_id, $lifecycle_event_type,
        'lifecycle:' || $evaluation_id, $event_payload, clock_timestamp());

-- Final authorization recheck with clock_timestamp(); then COMMIT.
```

The next-status value is selected from the approved lifecycle transition table,
never accepted directly from an API caller. `PASS` can promote an intermediate
stage; final success additionally requires the approved final-stage and verified
100%-target traffic predicates. `FAIL` enters the canary-failure/rollback path.
`INDETERMINATE` never promotes; its exhaustion policy remains open below.

If a retry finds `consumed_at` already set, it may return the prior transition
only when `consumed_by_revision = deployments.revision`, the stable lifecycle
idempotency event exists, and the submitted identity matches. It must not run a
second transition. Otherwise return conflict. Because consumption, deployment
revision/status, and event insertion commit together, any failed conditional
mutation rolls all of them back. If a lifecycle transition commits first, later
result acceptance fails the deployment-state/revision predicate and cannot
override it.

---

### 5.5 Stage Substate & Traffic Transition Protocols (Three-Phase Separation)

#### 1. Persist Intent (`INTENT_RECORDED` - Short DB Transaction)
```sql
BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED;

-- 1. Universal Authorization Guard
SELECT owner_id, epoch, lease_expires_at FROM coordinator WHERE id = 'singleton' FOR UPDATE;
-- Assert owner_id == $my_owner_id, epoch == $my_epoch, lease_expires_at > clock_timestamp()

-- 2. Guarded stage update
UPDATE deployment_stages
SET status = 'INTENT_RECORDED',
    desired_canary_pct = $target_pct,
    desired_stable_pct = $stable_pct,
    operation_id = $op_id,
    operation_revision = $expected_revision,
    apply_attempt = apply_attempt + 1,
    updated_at = clock_timestamp()
WHERE id = $stage_id
  AND deployment_id = $deployment_id
  AND status IN ('UNEVALUATED', 'FAILED');

-- Assert affected_rows == 1; IF 0 THEN ROLLBACK; RAISE 'Stage update conflict';

-- 3. Record desired observation
INSERT INTO traffic_observations (
    id, deployment_id, stage_id, deployment_revision, coordinator_epoch,
    observation_type, stable_weight_pct, target_weight_pct, is_fresh, observed_at
) VALUES (
    gen_random_uuid(), $deployment_id, $stage_id, $expected_revision, $my_epoch,
    'DESIRED', $stable_pct, $target_pct, true, clock_timestamp()
);

-- 4. Record audit event
INSERT INTO deployment_events (id, deployment_id, event_type, payload, occurred_at)
VALUES (gen_random_uuid(), $deployment_id, 'STAGE_INTENT_RECORDED', $payload, clock_timestamp());

COMMIT;
```

#### 2. Apply Kubernetes Ingress (Three-Phase Protocol)

- **Phase 1: Record Intent `APPLYING` (Short DB Transaction):**
  Use the common lock order and configured mutation-timeout guard, update `deployment_stages.status = 'APPLYING'` (assert `affected_rows == 1`), recheck authorization, then commit.
- **Phase 2: Mutate Ingress (Outside DB Transaction):**
  Issue HTTP write to Kubernetes API with optimistic concurrency (`resourceVersion`). No DB connection held.
- **Phase 3: Acknowledge `APPLIED` (Short DB Transaction):**
```sql
BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED;

-- 1. Universal Authorization Guard (fresh lock)
SELECT owner_id, epoch, lease_expires_at FROM coordinator WHERE id = 'singleton' FOR UPDATE;
-- Assert owner_id == $my_owner_id, epoch == $my_epoch, lease_expires_at > clock_timestamp()

-- 2. Guarded stage update
UPDATE deployment_stages
SET status = 'APPLIED',
    applied_canary_pct = $target_pct,
    applied_stable_pct = $stable_pct,
    ingress_uid = $ingress_uid,
    ingress_resource_version = $ingress_version,
    ingress_generation = $ingress_gen,
    updated_at = clock_timestamp()
WHERE id = $stage_id
  AND deployment_id = $deployment_id
  AND status = 'APPLYING';

-- Assert affected_rows == 1; IF 0 THEN ROLLBACK; RAISE 'Stage update conflict';

-- 3. Record applied observation
INSERT INTO traffic_observations (
    id, deployment_id, stage_id, deployment_revision, coordinator_epoch,
    observation_type, stable_weight_pct, target_weight_pct, ingress_uid,
    ingress_resource_version, ingress_generation, is_fresh, observed_at
) VALUES (
    gen_random_uuid(), $deployment_id, $stage_id, $expected_revision, $my_epoch,
    'APPLIED', $stable_pct, $target_pct, $ingress_uid, $ingress_version, $ingress_gen, true, clock_timestamp()
);

-- 4. Record audit event
INSERT INTO deployment_events (id, deployment_id, event_type, payload, occurred_at)
VALUES (gen_random_uuid(), $deployment_id, 'TRAFFIC_APPLIED', $payload, clock_timestamp());

COMMIT;
```

#### 3. Complete ALB Data-Plane Verification Protocol (`VALIDATING`)

A single ALB read must **never** establish verified traffic or authorize promotion. The observation protocol strictly separates external reads from database commits:

- **External Observation Steps (Executed outside any DB transaction):**
  1. **Kubernetes read 1:** Read the Ingress and capture UID, resourceVersion, generation, host/path, and the intended operation ID/revision metadata.
  2. Map that exact host/path to one managed AWS ELBv2 listener rule; ambiguity or multiple matches fails closed.
  3. **ALB read 1 ($T_0$):** Call `DescribeRules`; capture the listener rule ARN, target group ARNs, action digest, and configured forward weights.
  4. Wait the configured stabilization interval outside any database transaction.
  5. **ALB read 2 ($T_1$):** Call `DescribeRules` again. Require the same rule, target groups, action digest, and weights as read 1.
  6. **Kubernetes read 2:** Re-read the Ingress. Require the same UID, resourceVersion, generation, host/path, operation ID, and revision as read 1 and the persisted APPLIED intent.
  7. In a short database transaction, acquire coordinator, deployment, and stage locks in that order. Revalidate owner/epoch/expiry with `clock_timestamp()` after locks and check deployment revision, active stage, operation ID, and expected lifecycle status. Reject the observation if any identity changed during the external reads.
  8. Persist the matched observation conditionally with those identity predicates; recheck coordinator authorization immediately before commit.
  9. **Safety determination:**
     - Target weight == 0% and stable == 100% during rollback: `traffic_safety = 'VERIFIED_STABLE'`
     - Target weight == 0% prior to rollout: `traffic_safety = 'NOT_EXPOSED'`
     - Target weight > 0%: `traffic_safety = 'EXPOSED'`
     - Unstable, contradictory, or unmappable: persist an observation with nullable weights and `is_fresh = false`; set current safety to `UNKNOWN`.

These ALB weights describe configured routing weights. They do not prove exact
live request proportions. Live request distribution belongs to telemetry and
health evaluation, not this verification gate.

- **Post-Verification Acknowledgment (Short DB Transaction):**
```sql
BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED;

-- 1. Universal Authorization Guard (fresh lock)
SELECT owner_id, epoch, lease_expires_at FROM coordinator WHERE id = 'singleton' FOR UPDATE;
-- Assert owner_id == $my_owner_id, epoch == $my_epoch, lease_expires_at > clock_timestamp()

-- 2. Lock the same deployment row used by health acceptance/lifecycle changes.
SELECT id FROM deployments
WHERE id = $deployment_id
  AND revision = $expected_revision
  AND status = $expected_deployment_status
  AND current_stage_index = $stage_index
FOR UPDATE;
-- Require one row and recheck coordinator authorization after this lock.

SELECT id FROM deployment_stages
WHERE id = $stage_id
  AND deployment_id = $deployment_id
  AND stage_index = $stage_index
  AND operation_id = $op_id
  AND operation_revision = $expected_revision
  AND status = 'APPLIED'
FOR UPDATE;
-- Require one row; recheck coordinator authorization.

-- 3. Persist the observation only for the exact deployment/stage operation.
UPDATE deployment_stages
SET status = CASE WHEN $is_rollback THEN status ELSE 'VALIDATING' END,
    observed_canary_pct = $observed_target_pct,
    observed_stable_pct = $observed_stable_pct,
    listener_rule_arn = $rule_arn,
    stable_target_group_arn = $stable_tg_arn,
    target_target_group_arn = $target_tg_arn,
    last_observed_at = clock_timestamp(),
    validation_started_at = CASE WHEN $is_rollback THEN validation_started_at ELSE clock_timestamp() END,
    updated_at = clock_timestamp()
WHERE id = $stage_id
  AND deployment_id = $deployment_id
  AND operation_id = $op_id
  AND operation_revision = $expected_revision
  AND status = 'APPLIED';

-- Assert affected_rows == 1; IF 0 THEN ROLLBACK; RAISE 'Stage update conflict';

-- 4. Update deployment safety and, only for verified rollback, terminal status
UPDATE deployments
SET traffic_safety = CASE
        WHEN $is_rollback AND $weights_match AND $observed_stable_pct = 100
             AND $observed_target_pct = 0 THEN 'VERIFIED_STABLE'
        WHEN $weights_match AND $observed_target_pct > 0 THEN 'EXPOSED'
        WHEN $weights_match AND $observed_target_pct = 0 AND $no_prior_target_exposure THEN 'NOT_EXPOSED'
        WHEN NOT $weights_match THEN 'UNKNOWN'
        ELSE traffic_safety
    END,
    status = CASE WHEN $is_rollback AND $weights_match
                       AND $observed_stable_pct = 100 AND $observed_target_pct = 0
                  THEN 'ROLLED_BACK' ELSE status END,
    revision = revision + CASE WHEN $is_rollback AND $weights_match
                                    AND $observed_stable_pct = 100 AND $observed_target_pct = 0
                               THEN 1 ELSE 0 END,
    completed_at = CASE WHEN $is_rollback AND $weights_match
                             AND $observed_stable_pct = 100 AND $observed_target_pct = 0
                        THEN clock_timestamp() ELSE completed_at END,
    traffic_observed_at = clock_timestamp(),
    traffic_observation_source = 'alb_describe_rules_stabilized',
    updated_at = clock_timestamp()
WHERE id = $deployment_id
  AND revision = $expected_revision
  AND current_stage_index = $stage_index
  AND status = $expected_deployment_status;

-- Assert affected_rows == 1; IF 0 THEN ROLLBACK; RAISE 'Deployment update conflict';

-- 5. Append matched (or explicitly unknown) observation; weights are both NULL
-- when ALB configuration could not be unambiguously parsed or matched.
INSERT INTO traffic_observations (
    id, deployment_id, stage_id, deployment_revision, coordinator_epoch,
    observation_type, stable_weight_pct, target_weight_pct, listener_rule_arn,
    target_group_arns, is_fresh, observed_at
) VALUES (
    gen_random_uuid(), $deployment_id, $stage_id, $expected_revision, $my_epoch,
    'OBSERVED', $observed_stable_pct, $observed_target_pct, $rule_arn,
    $tg_arns_json, $weights_match, clock_timestamp()
);

-- 6. Record a verified event only for a matched observation.
INSERT INTO deployment_events
    (id, deployment_id, event_type, idempotency_key, payload, occurred_at)
SELECT gen_random_uuid(), $deployment_id,
       CASE WHEN $is_rollback THEN 'ROLLBACK_VERIFIED' ELSE 'TRAFFIC_VERIFIED' END,
       'traffic-observed:' || $op_id || ':' || $expected_revision,
       $payload, clock_timestamp()
WHERE $weights_match
  AND (NOT $is_rollback OR ($observed_stable_pct = 100 AND $observed_target_pct = 0));

-- Final authorization recheck with clock_timestamp(); any failed predicate or
-- row count rolls back observation, traffic state, terminal transition, event.
COMMIT;
```

For rollback, `ROLLING_BACK -> ROLLED_BACK` and `traffic_safety = VERIFIED_STABLE`
are written in this same transaction and only when both reads agree on stable
100% / target 0%, Kubernetes identity still matches, and the deployment remains
at the expected rollback revision. If rollback retries are exhausted before
that proof, transition to `FAILED` with safety `EXPOSED` when fresh reads show
target weight above zero, otherwise `UNKNOWN`; never write `VERIFIED_STABLE` and
never report traffic as restored. `FAILED` is a lifecycle outcome, not a traffic
safety assertion.

---

## 6. Review Issue Resolution Register

| Review issue | Proposed resolution in this revision | Remaining boundary |
|---|---|---|
| Atomic health-result acceptance | One `READ COMMITTED` transaction locks coordinator → deployment → stage/evaluation, conditionally changes only `RUNNING` to `COMPLETE`, and inserts the accepted-result event in the same transaction. Any failed predicate, unique-key violation, or final authorization check rolls back both writes. | Outcome normalization and the chosen HTTP conflict response need implementation review. |
| Lifecycle serialization | Acceptance and lifecycle consumption lock the same deployment row. Both predicates bind deployment status/revision/current stage, stage ID/index/status, target image, evaluation ID/attempt ID, and coordinator epoch. | Lifecycle table remains the source of allowed `$next_status`; implementation must not accept it from callers. |
| Coordinator fencing | PostgreSQL lease is authoritative. Lock order and post-lock/pre-mutation/final pre-commit checks use `clock_timestamp()`. Expiry while waiting causes rollback; renewal is a separate transaction. Acquisition increments epoch only after an unowned/expired lease; renewal requires a live lease and exact owner/epoch. | Short transaction/statement/lock timeout values remain deployment configuration. The final DB check is not a Kubernetes-side epoch fence. |
| Duplicate result semantics | First serialized valid commit wins. Exact replay compares stored result, failure reason, planned window end, and JSONB observations; it returns the existing result/event without writes. A conflicting replay returns conflict and never updates the completed attempt. The unique result event key is per evaluation. | Decide the external API status/body for conflict and replay. |
| Attempt binding/consumption | Immutable tuple binds deployment, stage/index, revision, target image, attempt ID, and creation epoch. Consumption requires current epoch and a fresh complete result; `consumed_at` and `consumed_by_revision` commit atomically with one transition. | Whether `INDETERMINATE` remains VALIDATING or enters failure after a configured policy is open. |
| ALB verification | Two Kube identity reads bracket two identical ALB rule reads separated by configured stabilization; then a locked DB transaction revalidates owner/epoch/revision/stage/operation before persisting. Weights represent configured routing, not exact request proportions. | Rule discovery, freshness/stabilization intervals, and read retries need deployment-specific configuration. |
| Prisma/SQL consistency | Explicit `map` names for represented indexes; named SQL checks and composite FK are listed. The running-attempt partial unique index is identified as required migration-only SQL because Prisma 6.16.2 cannot model its predicate. | Review the raw migration and verify this index and all check constraints in a disposable PostgreSQL catalog. |
| Migration safety | Existing `20261009135031_init` is immutable and its recovered checksum is recorded above. New required fields have no fabricated historical values. Populated targets require separately approved, source-derived staged backfills; otherwise migration stops. | Approval of any future migration/backfill is separate from approval of this design. |
| Traffic safety/rollback | `FAILED` retains `EXPOSED` or `UNKNOWN`; it never asserts restoration. Only a matching two-read proof can atomically set `ROLLING_BACK → ROLLED_BACK` with `VERIFIED_STABLE`. Unknown state fails closed and alerts; exhaustion ends in `FAILED`, not `ROLLED_BACK`. | Rollback retry/exhaustion policy and alert destination remain configuration/operations decisions. |
| Deterministic concurrency tests | Explicit two-session schedules and expected persisted rows/events are listed in Section 7. | Tests must run only on a separate disposable database after design approval. |

## 7. Deterministic Concurrency Test Plan (Design Only)

All scenarios use a separate disposable PostgreSQL database with two explicit
sessions and test barriers/locks, not timing sleeps. Assert transaction results,
deployment revision/status, attempt state, traffic safety, and exact event count.

| Scenario | Deterministic schedule | Required assertion |
|---|---|---|
| Result acceptance vs. attempt abandonment | A begins acceptance and locks coordinator/deployment/evaluation; B begins takeover/abandonment and blocks on coordinator. Commit A, then allow B to acquire a higher epoch and run abandonment. Repeat with B acquiring first. | First order: accepted result remains COMPLETE and abandonment updates zero rows for it. Second order: attempt becomes INCOMPLETE and A is rejected as stale. No attempt is both accepted and abandoned; no duplicate event. |
| Result acceptance vs. lifecycle transition | A and B contend for the same coordinator and deployment row. Run A first then B; repeat B first then A with B representing a competing terminal/failure transition. | If acceptance commits first, only a transition consuming that exact evaluation at expected revision can advance. If lifecycle commits first, acceptance sees changed status/revision and writes neither result nor event. |
| Identical duplicate submissions | A accepts and commits; B submits the byte/normalized-equivalent payload after waiting on the attempt row. Also simulate A's response being lost, then replay. | Both callers receive the same accepted evaluation/event identity; one stored result and exactly one accepted-result event. B makes no write. |
| Conflicting concurrent submissions | A locks the attempt and submits PASS; B submits FAIL for the same tuple and waits. Reverse lock order in a second run. | The first valid serialized commit remains immutable. The second gets conflict; no overwrite, no second accepted event, no lifecycle transition from the rejected value. |
| Stale coordinator epoch | Replace the current owner/epoch, then submit using the former epoch; also test a request that waited for coordinator lock across takeover. | Authorization fails after lock acquisition; no result, event, or lifecycle mutation commits. |
| Lease renewal vs. takeover | Renewal and takeover contend on the coordinator row. Exercise renewal while live and takeover after expiry. | Exactly one wins according to the row-locked `clock_timestamp()` predicate. Renewal never resurrects an expired lease; takeover increments epoch once; loser changes nothing. |
| Lease expires while waiting for a lock | Hold deployment row in session A. In session B, acquire coordinator lock while valid, then block on deployment row until lease expiry; release A. | B rechecks expiry after acquiring deployment lock, rolls back, and persists no mutation/event. A fresh renewal/takeover is required. |
| Duplicate attempt consumption | Two lifecycle consumers submit the same evaluation; first locks and commits, second waits and retries. | One updates `consumed_at`, one increments deployment revision, and one lifecycle event is stored. Retry returns prior transition only when idempotency event/revision match; otherwise conflict. |
| Conditional mutation failure and transaction rollback | Force the deployment revision/status predicate or event unique key to fail after the evaluation/consumption update but before commit. | Entire transaction rolls back: evaluation completion/consumption, deployment status/revision, observations, and events remain at their pre-transaction values. |

## 8. Migration Safety and Disposable Verification Plan

The existing baseline SQL and `migration_lock.toml` remain unchanged. Before any
future migration is approved, verify its parent migration name/checksum and
catalog against the recovered baseline. Never edit `_prisma_migrations` to make
history appear consistent, and never apply a generated migration to the current
Compose database as a test.

Rehearse only against a separate disposable PostgreSQL instance/project/volume:

1. Build an isolated working copy from the recovered baseline schema, original
   migration SQL, and lock file; point only that copy at the disposable DB.
2. Apply the proposed next migration there, then compare every Prisma field,
   physical index name/definition, CHECK, FK, enum, default, and nullability with
   the resulting catalog. Specifically assert the partial-index predicate
   `completion = 'RUNNING'` and all weight/status checks.
3. Verify `migrate status` reports the baseline and proposed migration complete,
   and verify the first migration checksum remains byte-for-byte unchanged.
4. Run the deterministic concurrency scenarios from Section 7 on a fresh test
   database. Tear down only the disposable resources after review.

For any populated future target, add new columns nullable first, backfill only
from authoritative existing data or an explicitly reviewed operator-supplied
mapping, validate row counts and semantic invariants, then add `NOT NULL` and
checks in a later step. Do not invent attempt IDs, coordinator epochs, target
images, completion outcomes, or traffic-safety values. If a required value
cannot be derived without guessing, stop and request a separate migration/data
decision; do not use sentinels or mark historical attempts COMPLETE by inference.

## 9. Remaining Open Decisions and Review Request

These values and policies are deliberately not invented here:

- Health window duration, minimum duration, missing-signal wait, and signal
  freshness bounds.
- Coordinator lease duration, renewal cadence, and operation-specific timeouts.
- ALB stabilization interval, observation freshness bound, discovery/read retry
  limits, and traffic exposure definition for an unknown write outcome.
- Whether `INDETERMINATE` leaves the deployment in `VALIDATING` or triggers the
  configured failure/rollback policy after its retry budget.
- Rollback retry/exhaustion policy and alert destination for `FAILED/EXPOSED` or
  `FAILED/UNKNOWN`.
- Whether the single in-process health evaluator remains a permanent MVP
  constraint; separate workers require durable worker identity/liveness design.
- Whether the team accepts the required partial unique index and named SQL-only
  checks/composite FK as migration-managed objects under Prisma 6.16.2, or plans
  a separately approved Prisma upgrade before implementation.
- API response contract for exact replay versus conflicting result submission.

**Review requested.** This is a revised proposal only. The design is not approved;
no schema, application code, migration, or database change is authorized by this
document. Please review the issue register, SQL-only invariant inventory,
concurrency schedules, and open decisions before deciding whether Step 5 can be
approved.
