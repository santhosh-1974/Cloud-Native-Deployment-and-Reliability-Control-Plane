# Controller Persistence Schema Design

**Status:** Draft for review  
**Scope:** Phase 1, Step 5 — Schema design only. No implementation changes.  
**Purpose:** Define the PostgreSQL schema required to support the controller state machine, safety invariants, and recovery protocol approved in `CONTROLLER_STATE_MACHINE_DESIGN.md` and `ARCHITECTURE.md`.

## Repository state at the time of this design

The Prisma schema is located at `controller/prisma/schema.prisma`. It currently defines:

- **Models:** `Application`, `Deployment`, `DeploymentStage`, `HealthEvaluation`, `DeploymentEvent`
- **Enums:** `DeploymentStatus`, `StageStatus`, `EvaluationResult`, `DeploymentEventType`
- **Migration history:** One migration — `20261009135031_init` — which creates all five tables from scratch with their existing columns, constraints, and indexes.

No second migration exists. No production data exists. This is a **greenfield persistence implementation**: the baseline tables exist in code only, not in a running database.

This fact eliminates any concern about backward compatibility with pre-existing rows. The design below describes the **complete initial persistence schema** (baseline plus all additions) and the **single additional migration** that extends the baseline schema to include the controller-required tables and columns.

## 1. Design principles

- **PostgreSQL is the source of truth:** All authoritative deployment state, ownership, fencing, and safety information resides in PostgreSQL. Kubernetes and ALB observations are persisted as evidence but are not the durable source of truth.
- **No Redis:** All coordination, serialization, and fencing is PostgreSQL-backed.
- **Atomic transitions:** Lifecycle transitions, stage state changes, and health result acceptance use conditional updates on expected state and revision.
- **Crash-safe recovery:** All critical operations (intent, acknowledgment, health result, epoch change) are persisted before external side effects. Recovery reads durable state and re-observes external systems.
- **Epoch fencing:** The coordinator epoch is monotonic and persisted in a singleton row. Health attempts record the epoch at creation. Abandonment targets attempts with epoch less than the current epoch.
- **No invented configuration values:** Lease duration, renewal interval, mutation timeouts, and health window durations are required configuration values defined at deployment time, not in the schema.

## 2. Baseline schema (existing — `20261009135031_init`)

The following tables and columns exist from the initial migration. They are not changed by the new migration described in Section 5; they are the foundation upon which the new columns and tables are added.

| Table | Key columns | Key indexes |
|-------|------------|-------------|
| `applications` | `id`, `name` (unique), `config`, timestamps | `applications_name_key` |
| `deployments` | `id`, `application_id` (FK), `request_identity` (unique), `target_image`, `stable_image`, `desired_replicas`, `port`, `strategy`, `status`, `current_stage_index`, `revision`, `rollback_reason`, `rollback_outcome`, timestamps | `idx_deployments_by_app_status`, `idx_deployments_by_app` |
| `deployment_stages` | `id`, `deployment_id` (FK), `stage_index`, `desired_canary_pct`, `desired_stable_pct`, `applied_canary_pct`, `applied_stable_pct`, `observed_canary_pct`, `observed_stable_pct`, `status`, `operation_id`, `operation_revision`, `apply_attempt`, `validation_started_at`, `validation_ended_at`, `completed_at`, `failure_reason`, timestamps | `idx_stages_by_deployment`, `uq_stage_per_deployment` |
| `health_evaluations` | `id`, `deployment_id` (FK), `stage_id` (FK), `deployment_revision`, `window_start`, `window_end`, `result`, `is_fresh`, `failure_reason`, `observations`, timestamps | `idx_health_evals_by_stage`, `idx_health_evals_by_revision` |
| `deployment_events` | `id`, `deployment_id` (FK), `event_type`, `payload`, `occurred_at` | `idx_events_by_deployment`, `idx_events_by_type` |

**Enums defined in the baseline:**
- `DeploymentStatus`: `PENDING`, `DEPLOYING`, `CANARY`, `VALIDATING`, `PROMOTING`, `SUCCEEDED`, `CANARY_FAILED`, `ROLLING_BACK`, `ROLLED_BACK`, `FAILED`
- `StageStatus`: `UNEVALUATED`, `INTENT_RECORDED`, `APPLYING`, `APPLIED`, `VALIDATING`, `PASSED`, `FAILED`
- `EvaluationResult`: `PASS`, `FAIL`, `INDETERMINATE`
- `DeploymentEventType`: `DEPLOYMENT_CREATED`, `DEPLOYMENT_STARTED`, `STAGE_INTENT_RECORDED`, `TRAFFIC_APPLY_STARTED`, `TRAFFIC_APPLIED`, `TRAFFIC_VERIFIED`, `HEALTH_VALIDATION_STARTED`, `HEALTH_VALIDATION_PASSED`, `HEALTH_VALIDATION_FAILED`, `PROMOTION_STARTED`, `ROLLBACK_STARTED`, `ROLLBACK_VERIFIED`, `DEPLOYMENT_SUCCEEDED`, `DEPLOYMENT_FAILED`, `DEPLOYMENT_ROLLED_BACK`

## 3. New schema additions

### 3.1 Coordinator — Singleton ownership record

**Purpose:** Serialize controller ownership, track the fencing epoch, and enforce lease-based safety for Kubernetes mutations.

**Schema gap:** The baseline schema has no coordinator row. The state machine design requires a singleton PostgreSQL row with owner ID, epoch, lease expiry, and renewal timestamp.

**New table:** `coordinator`

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| `id` | `TEXT` | PRIMARY KEY, value `'singleton'` | Single-row table identifier |
| `owner_id` | `TEXT` | NULLABLE | Identifier of the current coordinator owner (e.g., process ID, host). NULL indicates no current owner. |
| `epoch` | `INTEGER` | NOT NULL, monotonic increment on acquisition | Fencing epoch; each new owner increments this value |
| `lease_expires_at` | `TIMESTAMP(3)` | NOT NULL | When the current lease expires (database time) |
| `renewed_at` | `TIMESTAMP(3)` | NOT NULL | Last successful lease renewal timestamp |
| `created_at` | `TIMESTAMP(3)` | NOT NULL, DEFAULT `now()` | Row creation timestamp |
| `updated_at` | `TIMESTAMP(3)` | NOT NULL, DEFAULT `now()` | Last update timestamp |

**Indexes:**
- Primary key on `id` (singleton row)
- No additional indexes needed (single-row table)

**Constraints:**
- Only one row exists (`id = 'singleton'`)
- `epoch` must increase on every ownership transfer
- `lease_expires_at` must be > current database time for valid ownership
- Acquisition locks the row and succeeds only when no live lease exists

**Transaction semantics:**
- **Seed row (inserted by migration):** `id = 'singleton'`, `owner_id = NULL` (no current owner), `epoch = 0`, `lease_expires_at = '1970-01-01'` (expired, so the first process can immediately acquire), `renewed_at = now()`. This row is created by the migration and must exist before any coordinator process starts.
- **Acquisition:** `SELECT FOR UPDATE` on the singleton row, verify `lease_expires_at < now()` using database time, increment `epoch`, set new `owner_id`, set new `lease_expires_at` (database time + configured lease duration), and set `renewed_at = now()`. The epoch must increment monotonically on every ownership transfer.
- **Renewal:** Conditional `UPDATE` where `owner_id` matches the current owner, `epoch` matches the current epoch, and `lease_expires_at > now()`. Update `lease_expires_at` (database time + configured lease duration) and `renewed_at = now()`.
- **Lease check:** Before any Kubernetes mutation, compute `remaining_lease = lease_expires_at - now()` using database time. Start mutation only if `remaining_lease > configured_mutation_timeout`. If not, renew the lease first and re-check.

**Open design decision:** The exact format of `owner_id` (process ID, UUID, host-based identifier) is not specified here. It must be unique enough to distinguish different coordinator instances.

### 3.2 Health evaluations — Enhanced attempt tracking

**Purpose:** Track health evaluation attempts with attempt identity, coordinator epoch, completion status, abandonment reason, and target version snapshot to support crash-safe recovery and epoch-based abandonment.

**Schema gap:** The baseline `health_evaluations` table lacks: explicit attempt ID, completion status (`RUNNING`, `COMPLETE`, `INCOMPLETE`), coordinator epoch, abandonment reason, and a `target_image` snapshot. Because this is a greenfield implementation with no existing rows, these columns are added as `NOT NULL` where semantically required — no staged backfill is necessary.

**New columns on `health_evaluations`:**

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| `attempt_id` | `TEXT` (UUID) | NOT NULL | Unique identity for this evaluation attempt |
| `coordinator_epoch` | `INTEGER` | NOT NULL | The coordinator epoch when this attempt was created |
| `completion` | `TEXT` (ENUM) | NOT NULL, values: `RUNNING`, `COMPLETE`, `INCOMPLETE` | Attempt completion status (orthogonal to result) |
| `completed_at` | `TIMESTAMP(3)` | NULLABLE | When the attempt was completed or abandoned |
| `abandonment_reason` | `TEXT` | NULLABLE | Reason for abandonment (e.g., "epoch_change", "process_crash", "revision_change") |
| `target_image` | `TEXT` | NOT NULL | Snapshot of the target image at attempt creation |

**Note:** The existing baseline columns (`window_start`, `window_end`, `result`, `is_fresh`, `failure_reason`, `observations`) are retained unchanged.

**Open design decision — `result` nullability:** The baseline schema declares `result EvaluationResult NOT NULL`. With the new `completion` column, a `RUNNING` attempt has not yet produced a result. Two resolution options exist:

1. **Make `result` nullable** in the new migration: `result` is `NULL` while the attempt is `RUNNING`, and set to `PASS`, `FAIL`, or `INDETERMINATE` when `completion` transitions to `COMPLETE`. This is semantically precise but requires an `ALTER COLUMN` on the existing baseline column.
2. **Keep `result` NOT NULL with a sentinel value**: Insert `INDETERMINATE` as the initial value for `RUNNING` attempts, and update it when the result arrives. This avoids an `ALTER COLUMN` but makes `INDETERMINATE` ambiguous (it can mean "still running" or "genuinely indeterminate result").

**This decision must be resolved before implementation.** The preferred resolution is option 1 (make `result` nullable) because it is semantically precise and avoids ambiguity. If approved, the migration must `ALTER COLUMN result DROP NOT NULL` on `health_evaluations`.

**Open design decision — health-observation structure:** The baseline `observations` column is a `JSONB` field with a flexible schema. The controller's result-acceptance logic reads individual signal values from this field. The exact shape of the observations object (field names, units, required vs. optional signals) must be defined before implementation. The schema does not enforce the shape; the application layer is responsible for validation.

**New indexes:**
- Unique index on `(deployment_id, stage_id, attempt_id)` to ensure one attempt ID per stage per deployment (canonical attempt-identity constraint)
- Index on `(coordinator_epoch, completion)` for efficient epoch-based abandonment queries
- Index on `(deployment_id, stage_id, coordinator_epoch, completion)` for targeted abandonment

**Transaction semantics:**
- **Attempt creation:** Insert with `attempt_id` (new UUID), `coordinator_epoch` (current epoch from coordinator row), `completion = 'RUNNING'`, `completed_at = NULL`, `target_image` snapshot.
- **Abandonment (epoch change):** Conditional `UPDATE` where `completion = 'RUNNING'` AND `coordinator_epoch < new_epoch`. Set `completion = 'INCOMPLETE'`, `completed_at = now()`, `abandonment_reason = 'epoch_change'`. Do not abandon attempts with `coordinator_epoch >= new_epoch`.
- **Abandonment (same-epoch crash):** If the coordinator process itself performs health evaluation, it may abandon its own `RUNNING` attempts on restart using the same conditional update. If separate worker processes perform health evaluation, abandonment requires a defined durable worker identity and liveness mechanism (open design decision per Section 9.1 of state machine design).
- **Result acceptance:** Conditional `UPDATE` where `attempt_id` matches, `completion = 'RUNNING'`, `deployment_revision` matches, `stage_id` matches, `coordinator_epoch` matches the current coordinator epoch (from the coordinator row), and deployment lifecycle is `VALIDATING`. If the attempt was marked `INCOMPLETE`, the revision changed, the epoch changed, or the lifecycle is no longer `VALIDATING`, the result is rejected. The `completion` status is orthogonal to the `result` (`PASS`, `FAIL`, `INDETERMINATE`); a result can only be recorded on a `COMPLETE` attempt, and `PASS` is only allowed on `COMPLETE` when the full interval and all required signals are available and fresh.

**Concurrency and serialization:** Concurrent result submission and abandonment are serialized by the conditional `UPDATE` guard. Only one transaction can successfully transition `completion` from `RUNNING` to `COMPLETE` or `INCOMPLETE`. The first transaction to succeed commits; subsequent attempts fail the conditional guard and must reload state.

**Safety guarantee:** Late results from abandoned attempts cannot authorize promotion because the conditional write guard checks `completion = 'RUNNING'`, matching `attempt_id`, `deployment_revision`, `coordinator_epoch` (against the coordinator row), and lifecycle `VALIDATING`. Even if a stale worker from a previous epoch is still running and submits a result, the result is rejected because the attempt is marked `INCOMPLETE` or the epoch no longer matches the current coordinator epoch.

### 3.3 Traffic safety — Observation tracking

**Purpose:** Persist traffic safety state and observation history to distinguish between desired, applied, and verified traffic, and to support crash-safe recovery.

**Schema gap:** The baseline `deployments` table has no `traffic_safety` field. The baseline `deployment_stages` table has `desiredCanaryPct`, `appliedCanaryPct`, `observedCanaryPct` but no separate traffic safety enumeration and no observation timestamp or freshness tracking. No traffic observation history table exists.

**New columns on `deployments`:**

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| `traffic_safety` | `TEXT` (ENUM) | NOT NULL, values: `NOT_EXPOSED`, `EXPOSED`, `UNKNOWN`, `VERIFIED_STABLE` | Current traffic safety state |
| `traffic_observed_at` | `TIMESTAMP(3)` | NULLABLE | Timestamp of the last authoritative traffic observation |
| `traffic_observation_source` | `TEXT` | NULLABLE | Source of the observation (e.g., "alb_describe_rules") |

**Default for new rows:** `traffic_safety = 'UNKNOWN'`. This is the conservative initial value; the controller updates it after observing actual traffic state.

**New table:** `traffic_observations`

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| `id` | `TEXT` (UUID) | PRIMARY KEY | Observation record identifier |
| `deployment_id` | `TEXT` | NOT NULL, FK to `deployments` | Associated deployment |
| `stage_id` | `TEXT` | NULLABLE, FK to `deployment_stages` | Associated stage (if observation is stage-specific) |
| `deployment_revision` | `INTEGER` | NOT NULL | Deployment revision at observation time |
| `coordinator_epoch` | `INTEGER` | NOT NULL | Coordinator epoch at observation time |
| `observation_type` | `TEXT` (ENUM) | NOT NULL, values: `DESIRED`, `APPLIED`, `OBSERVED` | Type of traffic observation |
| `stable_weight_pct` | `INTEGER` | NOT NULL | Stable traffic percentage (0-100) |
| `target_weight_pct` | `INTEGER` | NOT NULL | Target traffic percentage (0-100) |
| `ingress_uid` | `TEXT` | NULLABLE | Kubernetes Ingress UID (for applied observations) |
| `ingress_resource_version` | `TEXT` | NULLABLE | Kubernetes Ingress resourceVersion (for applied observations) |
| `ingress_generation` | `INTEGER` | NULLABLE | Kubernetes Ingress generation (for applied observations) |
| `listener_rule_arn` | `TEXT` | NULLABLE | AWS ELBv2 listener rule ARN (for observed observations) |
| `target_group_arns` | `JSONB` | NULLABLE | Array of target group ARNs and weights observed in ALB |
| `is_fresh` | `BOOLEAN` | NOT NULL, DEFAULT `true` | Whether this observation is still fresh |
| `observed_at` | `TIMESTAMP(3)` | NOT NULL | When this observation was made |
| `created_at` | `TIMESTAMP(3)` | NOT NULL, DEFAULT `now()` | Record creation timestamp |

**Indexes:**
- Primary key on `id`
- Index on `(deployment_id, stage_id, observed_at DESC)` for latest observation per stage
- Index on `(deployment_id, deployment_revision, observation_type)` for revision-specific observation queries
- Index on `(coordinator_epoch, observation_type)` for epoch-based cleanup

**Transaction semantics:**
- **Record desired traffic:** Insert `DESIRED` observation when stage intent is persisted.
- **Record applied traffic:** Insert `APPLIED` observation after Kubernetes Ingress write is acknowledged, with `ingress_uid`, `ingress_resource_version`, `ingress_generation`.
- **Record observed traffic:** Insert `OBSERVED` observation after authoritative ALB `DescribeRules` read, with `listener_rule_arn`, `target_group_arns`, and verified weights. The approved state machine design requires two ALB observations separated by a Kubernetes identity check: first ALB read to verify applied configuration, then a second ALB read after a configured stabilization interval to confirm the rule is stable.
- **Update `traffic_safety`:** After each authoritative observation, conditionally update `deployments.traffic_safety` based on the observation type and weights:
  - `NOT_EXPOSED`: Only before any nonzero target write, with verified zero target weight.
  - `EXPOSED`: When latest fresh observation shows target weight > 0 (including verified 100% target for success).
  - `VERIFIED_STABLE`: Only for `ROLLED_BACK` with fresh stable 100% / target 0% observation.
  - `UNKNOWN`: When traffic cannot be determined (observation unavailable, ambiguous, or stale).
- **Freshness tracking:** Mark `is_fresh = false` when a newer observation supersedes an old one, or when a configured freshness bound expires.

**Distinction between traffic states:**
- **Desired traffic intent:** PostgreSQL stage intent (stable/target weights) representing what the controller wants.
- **Applied Kubernetes configuration:** Kubernetes Ingress resource accepted at its new resourceVersion/generation, plus AWS Load Balancer Controller reconciliation status. This proves configuration was accepted by Kubernetes, not that the ALB is using it.
- **Observed ALB listener-rule configuration:** A fresh AWS Elastic Load Balancing v2 `DescribeRules` read of the listener rule mapped to the managed Ingress host/path and stable/target target-group ARNs. The forward action's target groups and configured weights must exactly match the desired stage. This verifies configured routing weights, not exact proportions of live requests.
- **`trafficSafety`:** A separate field on deployments summarizing the latest fresh observation's safety classification. It is not derived from lifecycle status alone.

**Safety guarantee:** `SUCCEEDED` requires `traffic_safety = 'EXPOSED'` with a fresh observation showing verified 100% target traffic and a fresh passing health evaluation at the final stage. `ROLLED_BACK` requires `traffic_safety = 'VERIFIED_STABLE'` with a fresh observation showing stable 100% / target 0% traffic. `FAILED` may retain `NOT_EXPOSED`, `EXPOSED`, or `UNKNOWN` but must not be presented as restored stable traffic. Unknown or stale observations cannot authorize promotion or rollback completion. Configured ALB weights do not prove exact live request proportions; they only prove the routing configuration.

### 3.4 Kubernetes/ALB observations — Detailed resource tracking

**Purpose:** Persist detailed Kubernetes resource state and ALB observations to support fencing, recovery, and verification of applied vs. observed state.

**Schema gap:** The baseline `deployment_stages` table has `appliedCanaryPct`, `appliedStablePct`, `observedCanaryPct`, `observedStablePct` but lacks the detailed Kubernetes and ALB metadata required for fencing (resourceVersion, generation, UID, listener rule ARN, target group ARNs).

**New columns on `deployment_stages`:**

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| `ingress_uid` | `TEXT` | NULLABLE | Kubernetes Ingress UID (for fencing) |
| `ingress_resource_version` | `TEXT` | NULLABLE | Kubernetes Ingress resourceVersion (for fencing) |
| `ingress_generation` | `INTEGER` | NULLABLE | Kubernetes Ingress generation (for fencing) |
| `listener_rule_arn` | `TEXT` | NULLABLE | AWS ELBv2 listener rule ARN (for verification) |
| `stable_target_group_arn` | `TEXT` | NULLABLE | ARN of the stable target group |
| `target_target_group_arn` | `TEXT` | NULLABLE | ARN of the target (canary) target group |
| `last_observed_at` | `TIMESTAMP(3)` | NULLABLE | Timestamp of the last authoritative ALB observation |

**Indexes (new):**
- Index on `(ingress_uid, ingress_resource_version)` for fencing conflict detection
- Index on `(listener_rule_arn)` for rule-to-deployment mapping

**Transaction semantics:**
- **Fencing write:** Before Kubernetes mutation, capture `ingress_uid` and `ingress_resource_version`. After the write, persist these values in the stage record along with the applied weights.
- **Verification:** After ALB `DescribeRules`, persist `listener_rule_arn`, target group ARNs, and observed weights. Update `last_observed_at`.
- **Fencing conflict:** If a concurrent write changes `ingress_resource_version`, the old worker's conditional update fails and must reload/reconcile.

**Safety guarantee:** Kubernetes mutations use the exact observed `resourceVersion` as a compare-and-swap precondition. If the resourceVersion has changed, the mutation is rejected and the worker must reload state and re-validate ownership.

## 4. Complete schema at implementation

After the initial migration (`20261009135031_init`) and the new migration described in Section 5, the complete schema will include the following tables and models:

| Table | Status | Models / additions |
|-------|--------|--------------------|
| `applications` | Baseline (unchanged) | `Application` model |
| `deployments` | Baseline + new columns | `traffic_safety`, `traffic_observed_at`, `traffic_observation_source` |
| `deployment_stages` | Baseline + new columns | `ingress_uid`, `ingress_resource_version`, `ingress_generation`, `listener_rule_arn`, `stable_target_group_arn`, `target_target_group_arn`, `last_observed_at` |
| `health_evaluations` | Baseline + new columns | `attempt_id`, `coordinator_epoch`, `completion`, `completed_at`, `abandonment_reason`, `target_image`; possible `result` nullability change (see Section 3.2) |
| `deployment_events` | Baseline (unchanged) | `DeploymentEvent` model |
| `coordinator` | New | Full `Coordinator` model |
| `traffic_observations` | New | Full `TrafficObservation` model |

## 5. Concurrency and transactions

### 5.1 Conditional updates for lifecycle transitions

**Pattern:** All lifecycle transitions use conditional `UPDATE` statements that check expected state and revision.

**Example for `DEPLOYING → CANARY`:**
```sql
UPDATE deployments
SET status = 'CANARY',
    revision = revision + 1,
    updated_at = now()
WHERE id = $deployment_id
  AND status = 'DEPLOYING'
  AND revision = $expected_revision;
```

If the update affects 0 rows, the transition is rejected (stale revision or unexpected state). The worker must reload state and re-validate ownership.

### 5.2 Atomic event recording

**Pattern:** Lifecycle transitions append an event in the same transaction as the state change.

**Example:**
```sql
BEGIN;
-- Update deployment status and revision
UPDATE deployments SET ... WHERE ...;
-- Append event
INSERT INTO deployment_events (deployment_id, event_type, payload, occurred_at)
VALUES ($deployment_id, 'DEPLOYMENT_STARTED', $payload, now());
COMMIT;
```

The event record is durable evidence of the transition and survives crashes.

### 5.3 Stale-result rejection

**Pattern:** Health result acceptance must be serialized against coordinator takeover and deployment lifecycle transitions. The transaction locks the coordinator row to prevent ownership transfer between the epoch read and the health result write. Lease validity must still be checked even with the row lock. The result update is atomic: it updates result, completion, completed_at, and associated metadata in one conditional operation.

**Example:**
```sql
BEGIN;
-- Lock the coordinator row to serialize against takeover
SELECT epoch, owner_id, lease_expires_at INTO current_epoch, current_owner, current_lease_expiry
FROM coordinator
WHERE id = 'singleton'
FOR UPDATE;


-- Verify lease is still valid (holding the lock does not guarantee lease validity)
IF current_lease_expiry <= now() THEN
    ROLLBACK;
END IF;

-- Verify current owner identity matches the worker's coordinator identity
IF current_owner != $worker_coordinator_identity THEN
    ROLLBACK;
END IF;

-- Verify current epoch matches the attempt epoch and worker epoch
IF current_epoch != $attempt_epoch OR current_epoch != $worker_epoch THEN
    ROLLBACK;
END IF;

-- Conditionally update the health evaluation with atomic completion and result
UPDATE health_evaluations
SET result = $result,
    completion = 'COMPLETE',
    completed_at = now(),
    failure_reason = $failure_reason,
    observations = $observations,
    is_fresh = true,
    updated_at = now()
WHERE id = $evaluation_id
  AND attempt_id = $attempt_id
  AND completion = 'RUNNING'
  AND deployment_revision = $expected_revision
  AND stage_id = $stage_id
  AND deployment_id = $deployment_id
  AND coordinator_epoch = current_epoch;

-- Verify the deployment is still in VALIDATING lifecycle and revision unchanged
SELECT status, revision INTO current_status, current_revision FROM deployments WHERE id = $deployment_id;
IF current_status != 'VALIDATING' OR current_revision != $expected_revision THEN
    ROLLBACK;
END IF;

COMMIT;
```

**Protocol rationale:**
- The `SELECT FOR UPDATE` on the coordinator row acquires a lock that conflicts with the coordinator takeover transaction (which also locks the row with `SELECT FOR UPDATE` before incrementing the epoch). Coordinator takeover and lease renewal follow consistent row-locking and conditional-update rules (Section 3.1).
- The lease validity check ensures the coordinator's lease is still valid even though the row is locked. Holding the lock does not automatically mean the lease is valid. The lease can expire during the transaction if the transaction runs longer than the remaining lease time; the check prevents accepting a result after the lease has expired.
- The owner identity check ensures the current owner matches the worker's coordinator identity. If ownership transferred, the new owner's identity will not match the old worker's identity.
- The epoch check ensures the current epoch matches both the attempt epoch (when the attempt was created) and the worker epoch (the epoch the worker believes it owns). If the epoch changed, the result is rejected.
- The conditional UPDATE atomically transitions `completion` from `RUNNING` to `COMPLETE` and sets the result, `completed_at`, and metadata in one operation. This prevents a race where one transaction sets the result while another sets completion to `INCOMPLETE`.
- The deployment lifecycle and revision check ensures the deployment is still in `VALIDATING` state and the revision has not changed. If a lifecycle transition (e.g., to `CANARY_FAILED` or `PROMOTING`) occurred during the result transaction, the check fails and the result is rejected.
- If a coordinator takeover attempts to acquire the lock while a health result transaction is in progress, the takeover will wait for the result transaction to complete (due to row lock conflict).
- After the result transaction commits, the takeover can proceed. If the epoch changed during the result transaction, the coordinator row lock ensures the takeover sees the post-result state, and the result's conditional update guard (checking `coordinator_epoch`) will have rejected the result if the epoch no longer matches.
- If the takeover acquired the lock first, the result transaction will wait. When it proceeds, it will read the new epoch, and the conditional update guard will reject the result because `coordinator_epoch` no longer matches.
- If a lifecycle transition attempts to update the deployment status while a result transaction is in progress, the lifecycle transition uses a conditional UPDATE on the deployment revision (Section 5.1). The result transaction also checks the deployment revision. The first transaction to commit wins; the second transaction's conditional UPDATE will fail because the revision no longer matches, and it must reload state.
- This protocol ensures that a health result from a previous coordinator epoch is never accepted after ownership has transferred, even if the old process is still running. It also ensures that a result is not accepted if the deployment lifecycle leaves `VALIDATING` or the revision changes before the result transaction commits.

**Concurrency behavior for competing submissions and abandonment:**
- **Competing result submissions:** Two workers attempting to submit results for the same attempt will both lock the coordinator row and attempt the conditional UPDATE. The first to succeed transitions `completion` to `COMPLETE` and commits. The second's conditional UPDATE fails because `completion` is no longer `RUNNING`. The second must reload state and cannot accept its result.
- **Abandonment during result submission:** If an abandonment (epoch change or process crash) attempts to mark the attempt `INCOMPLETE` while a result transaction is in progress, the abandonment transaction also locks the coordinator row and attempts a conditional UPDATE on `completion`. The first transaction to succeed (result or abandonment) commits. If abandonment wins, the result's conditional UPDATE fails because `completion` is no longer `RUNNING`. If result wins, the abandonment's conditional UPDATE fails because `completion` is no longer `RUNNING`. The winner commits; the loser must reload state.
- **Lifecycle transition during result submission:** If a lifecycle transition (e.g., to `CANARY_FAILED`) attempts to update the deployment while a result transaction is in progress, both transactions check the deployment revision. The first to commit wins; the second's conditional UPDATE fails because the revision no longer matches. The result acceptance transaction also explicitly checks the deployment status; if the status changed to non-`VALIDATING`, the result transaction rolls back.

If the update affects 0 rows, the result is rejected (attempt abandoned, revision changed, epoch changed, stage mismatched, or lifecycle changed). The coordinator epoch check is against the authoritative coordinator row (read under lock), not a local cached value or a Kubernetes annotation. Kubernetes does not enforce the epoch annotation; this is application-layer fencing.

### 5.4 Recovery after crashes

**Pattern:** On startup, the controller:
1. Acquires or renews coordinator ownership (Section 3.1).
2. If epoch changed, abandons `RUNNING` health attempts with `coordinator_epoch < new_epoch` (Section 3.2).

3. Reloads all non-terminal deployments.
4. Re-observes Kubernetes and ALB state.
5. Reconciles durable intent with actual state using conditional updates.

**Key invariant:** No in-memory state is authoritative. All decisions are based on durable PostgreSQL state plus fresh external observations.

## 6. Constraints and indexes

### 6.1 Primary keys

- `coordinator.id` — Singleton row (`'singleton'`)
- `applications.id` — UUID
- `deployments.id` — UUID
- `deployment_stages.id` — UUID
- `health_evaluations.id` — UUID
- `deployment_events.id` — UUID
- `traffic_observations.id` — UUID

### 6.2 Foreign keys

- `deployments.application_id` → `applications.id`
- `deployment_stages.deployment_id` → `deployments.id`
- `health_evaluations.deployment_id` → `deployments.id`
- `health_evaluations.stage_id` → `deployment_stages.id`
- `deployment_events.deployment_id` → `deployments.id`
- `traffic_observations.deployment_id` → `deployments.id`
- `traffic_observations.stage_id` → `deployment_stages.id` (nullable)

All foreign keys use `ON DELETE RESTRICT` to prevent accidental deletion of referenced records.

### 6.3 Uniqueness constraints

- `applications.name` — Unique application identifier
- `deployments.request_identity` — Idempotency key for deployment requests
- `deployment_stages.(deployment_id, stage_index)` — One stage per index per deployment
- `health_evaluations.(deployment_id, stage_id, attempt_id)` — One attempt ID per stage per deployment

### 6.4 Indexes for performance

**Baseline indexes (retained unchanged):**
- `idx_deployments_by_app_status` on `(application_id, status)`
- `idx_deployments_by_app` on `(application_id, created_at DESC)`
- `idx_stages_by_deployment` on `(deployment_id, stage_index)`
- `idx_health_evals_by_stage` on `(deployment_id, stage_id, created_at DESC)`
- `idx_health_evals_by_revision` on `(deployment_id, deployment_revision)`
- `idx_events_by_deployment` on `(deployment_id, occurred_at)`
- `idx_events_by_type` on `(event_type, occurred_at DESC)`

**New indexes required:**
- `uq_health_evals_attempt` unique index on `(deployment_id, stage_id, attempt_id)` — Canonical attempt-identity constraint
- `idx_health_evals_by_epoch_completion` on `(coordinator_epoch, completion)` — For epoch-based abandonment
- `idx_health_evals_by_deployment_stage_epoch` on `(deployment_id, stage_id, coordinator_epoch, completion)` — For targeted abandonment
- `idx_traffic_observations_by_deployment_stage` on `(deployment_id, stage_id, observed_at DESC)` — Latest observation per stage
- `idx_traffic_observations_by_deployment_revision` on `(deployment_id, deployment_revision, observation_type)` — Revision-specific queries
- `idx_traffic_observations_by_epoch` on `(coordinator_epoch, observation_type)` — Epoch-based cleanup
- `idx_stages_by_ingress` on `(ingress_uid, ingress_resource_version)` — Fencing conflict detection
- `idx_stages_by_listener_rule` on `(listener_rule_arn)` — Rule-to-deployment mapping

### 6.5 Nullability

**Required (NOT NULL):**
- All primary keys
- All foreign keys
- `deployments.status`, `deployments.revision`, `deployments.traffic_safety`
- `deployment_stages.stage_index`, `deployment_stages.status`
- `health_evaluations.attempt_id`, `health_evaluations.coordinator_epoch`, `health_evaluations.completion`, `health_evaluations.target_image`
- `coordinator.epoch`, `coordinator.lease_expires_at`, `coordinator.renewed_at`
- `traffic_observations.observation_type`, `traffic_observations.stable_weight_pct`, `traffic_observations.target_weight_pct`, `traffic_observations.coordinator_epoch`, `traffic_observations.observed_at`

**Nullable (allow NULL):**
- `coordinator.owner_id` (NULL indicates no current owner; set to non-NULL on acquisition)
- Optional metadata fields (`ingress_uid`, `listener_rule_arn`, etc.) when not yet observed
- `health_evaluations.completed_at` (NULL while `RUNNING`)
- `health_evaluations.abandonment_reason` (NULL if not abandoned)
- `health_evaluations.result` (NULL while `RUNNING` — pending resolution of open design decision in Section 3.2)
- `deployments.traffic_observed_at` (NULL if no observation yet)
- `traffic_observations.stage_id` (NULL for deployment-level observations)

### 6.6 Data types

- **IDs:** `TEXT` (UUID or string identifiers)
- **Enumerations:** `TEXT` with application-level validation (Prisma enums in implementation)
- **Timestamps:** `TIMESTAMP(3)` (millisecond precision)
- **Integers:** `INTEGER` (revision, percentages, counts)
- **JSON:** `JSONB` for flexible structured data (observations, strategy, target_group_arns)
- **Booleans:** `BOOLEAN`

## 7. Migration plan

### 7.1 Migration context

**Baseline migration:** `20261009135031_init` — creates all five baseline tables from scratch. This migration is already part of the repository. It has not been applied to any running database.

**New migration:** A single additional migration (to be named, e.g., `_controller_persistence`) extends the baseline schema with all additions described in Section 3. Because there is no production database and no existing rows, all new `NOT NULL` columns can be added directly without staged backfill.

The new migration does not alter the baseline migration. It is a second, independent migration step that Prisma applies after the init migration.

### 7.2 New migration — complete operations

All operations below are part of a single new migration. Because the database is empty when applied, no data backfill is required.

**1. Create the `coordinator` table and seed the singleton row:**
```sql
CREATE TABLE "public"."coordinator" (
    "id"               TEXT         NOT NULL,
    "owner_id"         TEXT,
    "epoch"            INTEGER      NOT NULL,
    "lease_expires_at" TIMESTAMP(3) NOT NULL,
    "renewed_at"       TIMESTAMP(3) NOT NULL,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coordinator_pkey" PRIMARY KEY ("id")
);

-- Seed the singleton row. owner_id is NULL (no current owner).
-- lease_expires_at is set to the Unix epoch so the first process can immediately acquire.
INSERT INTO "public"."coordinator" ("id", "owner_id", "epoch", "lease_expires_at", "renewed_at", "created_at", "updated_at")
VALUES ('singleton', NULL, 0, '1970-01-01 00:00:00', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
```

**2. Add new columns to `deployments`:**
```sql
ALTER TABLE "public"."deployments"
    ADD COLUMN "traffic_safety"             TEXT         NOT NULL DEFAULT 'UNKNOWN',
    ADD COLUMN "traffic_observed_at"        TIMESTAMP(3),
    ADD COLUMN "traffic_observation_source" TEXT;
```

Note: `DEFAULT 'UNKNOWN'` is required by PostgreSQL for a `NOT NULL` column addition even though the table is empty at migration time.

**3. Add new columns to `deployment_stages`:**
```sql
ALTER TABLE "public"."deployment_stages"
    ADD COLUMN "ingress_uid"              TEXT,
    ADD COLUMN "ingress_resource_version" TEXT,
    ADD COLUMN "ingress_generation"       INTEGER,
    ADD COLUMN "listener_rule_arn"        TEXT,
    ADD COLUMN "stable_target_group_arn"  TEXT,
    ADD COLUMN "target_target_group_arn"  TEXT,
    ADD COLUMN "last_observed_at"         TIMESTAMP(3);
```

**4. Add new columns to `health_evaluations`:**

If the open design decision in Section 3.2 resolves to make `result` nullable:
```sql
ALTER TABLE "public"."health_evaluations"
    ALTER COLUMN "result" DROP NOT NULL;
```

New columns (all NOT NULL where possible, since the table is empty at migration time):
```sql
ALTER TABLE "public"."health_evaluations"
    ADD COLUMN "attempt_id"         TEXT         NOT NULL,
    ADD COLUMN "coordinator_epoch"  INTEGER      NOT NULL,
    ADD COLUMN "completion"         TEXT         NOT NULL,
    ADD COLUMN "completed_at"       TIMESTAMP(3),
    ADD COLUMN "abandonment_reason" TEXT,
    ADD COLUMN "target_image"       TEXT         NOT NULL;
```

Note: `NOT NULL` without a `DEFAULT` is valid in PostgreSQL when the table is empty. These columns are added as `NOT NULL` directly because there are no existing rows to violate the constraint.

**5. Create the `traffic_observations` table:**
```sql
CREATE TABLE "public"."traffic_observations" (
    "id"                       TEXT         NOT NULL,
    "deployment_id"            TEXT         NOT NULL,
    "stage_id"                 TEXT,
    "deployment_revision"      INTEGER      NOT NULL,
    "coordinator_epoch"        INTEGER      NOT NULL,
    "observation_type"         TEXT         NOT NULL,
    "stable_weight_pct"        INTEGER      NOT NULL,
    "target_weight_pct"        INTEGER      NOT NULL,
    "ingress_uid"              TEXT,
    "ingress_resource_version" TEXT,
    "ingress_generation"       INTEGER,
    "listener_rule_arn"        TEXT,
    "target_group_arns"        JSONB,
    "is_fresh"                 BOOLEAN      NOT NULL DEFAULT true,
    "observed_at"              TIMESTAMP(3) NOT NULL,
    "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "traffic_observations_pkey" PRIMARY KEY ("id")
);
```

**6. Add foreign keys for `traffic_observations`:**
```sql
ALTER TABLE "public"."traffic_observations"
    ADD CONSTRAINT "traffic_observations_deployment_id_fkey"
        FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "public"."traffic_observations"
    ADD CONSTRAINT "traffic_observations_stage_id_fkey"
        FOREIGN KEY ("stage_id") REFERENCES "public"."deployment_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

**7. Create new indexes:**
```sql
-- health_evaluations
CREATE UNIQUE INDEX "uq_health_evals_attempt"
    ON "public"."health_evaluations"("deployment_id", "stage_id", "attempt_id");

CREATE INDEX "idx_health_evals_by_epoch_completion"
    ON "public"."health_evaluations"("coordinator_epoch", "completion");

CREATE INDEX "idx_health_evals_by_deployment_stage_epoch"
    ON "public"."health_evaluations"("deployment_id", "stage_id", "coordinator_epoch", "completion");

-- deployment_stages
CREATE INDEX "idx_stages_by_ingress"
    ON "public"."deployment_stages"("ingress_uid", "ingress_resource_version");

CREATE INDEX "idx_stages_by_listener_rule"
    ON "public"."deployment_stages"("listener_rule_arn");

-- traffic_observations
CREATE INDEX "idx_traffic_observations_by_deployment_stage"
    ON "public"."traffic_observations"("deployment_id", "stage_id", "observed_at" DESC);

CREATE INDEX "idx_traffic_observations_by_deployment_revision"
    ON "public"."traffic_observations"("deployment_id", "deployment_revision", "observation_type");

CREATE INDEX "idx_traffic_observations_by_epoch"
    ON "public"."traffic_observations"("coordinator_epoch", "observation_type");
```

### 7.3 Migration ordering rationale

The operations above follow this dependency order:
1. `coordinator` table is independent — created first.
2. `deployments` columns are independent of new tables — added next.
3. `deployment_stages` columns are independent of new tables — added next.
4. `health_evaluations` columns depend on no new tables — added next. If `result` is made nullable, that `ALTER COLUMN` must precede adding `completion` for clarity, but either order is mechanically valid since the table is empty.
5. `traffic_observations` table depends on `deployments` and `deployment_stages` existing — created after the base tables.
6. Foreign keys for `traffic_observations` are added after the table is created.
7. Indexes are created last (no dependencies; can be created in any order).

### 7.4 Rollback strategy

Because the database is empty and no data has been written:
- **Full rollback:** Drop the new tables (`coordinator`, `traffic_observations`) and drop the new columns from `deployments`, `deployment_stages`, and `health_evaluations`. The baseline schema is restored exactly.
- **No data loss:** There are no rows to lose because the database has not been populated.
- **Re-apply:** The migration can be re-applied cleanly after any schema corrections.

## 8. Failure scenarios

### 8.1 Coordinator takeover


**Scenario:** A new coordinator process acquires ownership while the previous process is still running (or crashed without releasing the lease).


**Recovery:**
1. New coordinator attempts to acquire ownership by locking the `coordinator` row.
2. If `lease_expires_at < now()`, the lease is expired. The new coordinator increments `epoch`, sets new `owner_id`, and sets a new `lease_expires_at`.
3. The new epoch invalidates the previous coordinator's authority regardless of whether the previous process has terminated.
4. The new coordinator queries all `health_evaluations` with `completion = 'RUNNING'` AND `coordinator_epoch < new_epoch` and conditionally marks them `INCOMPLETE` with `abandonment_reason = 'epoch_change'`.
5. The new coordinator does not abandon attempts with `coordinator_epoch >= new_epoch` (those belong to the current authority).
6. The new coordinator applies the Kubernetes fencing barrier (Section 9.3 of state machine design) to all managed resources.
7. Late results from the previous epoch are rejected by the conditional write guard (completion status no longer matches `RUNNING`).

**Safety guarantee:** Even if the old process is still running and submits a result, the result is rejected because the attempt is marked `INCOMPLETE` and the epoch no longer matches the current authority.

### 8.2 Competing health results

**Scenario:** Two workers (or a stale worker from a previous epoch) attempt to submit results for the same health evaluation attempt.

**Recovery:**
1. The first result reads the current coordinator epoch from the coordinator row, then uses a conditional `UPDATE` where `attempt_id` matches, `completion = 'RUNNING'`, `deployment_revision` matches, `stage_id` matches, `coordinator_epoch` matches the current coordinator epoch, and deployment lifecycle is `VALIDATING`.
2. If the update succeeds, the attempt is marked with the result and `completion` may be set to `'COMPLETE'`.
3. The second result's conditional `UPDATE` fails because `completion` is no longer `'RUNNING'` (or the revision changed, or the epoch changed).
4. The second result is discarded and cannot authorize promotion.

**Safety guarantee:** Only one result can be accepted per attempt. The conditional update guard with coordinator epoch check prevents duplicate or competing results. Even if a stale worker from a previous epoch is still running, its result is rejected because the epoch no longer matches the current coordinator epoch. Kubernetes does not enforce the epoch annotation; this is application-layer fencing.

### 8.3 Same-epoch crashes

**Scenario:** The coordinator process crashes while a health evaluation is in progress, but the epoch does not change (e.g., the process restarts and re-acquires the same lease).

**Recovery:**
1. The restarted process acquires ownership with the same epoch (if the lease is still valid).
2. For same-epoch initialization, abandonment of `RUNNING` attempts requires evidence that the attempt's owner is no longer active.
3. If health evaluation is performed by the coordinator process itself, the process may abandon its own `RUNNING` attempts on restart using the same conditional update procedure.
4. If health evaluation is performed by separate worker processes, the current architecture does not provide enough information to determine worker liveness safely. A process must not abandon another worker's `RUNNING` attempt without a defined durable worker identity and liveness mechanism (open design decision per Section 9.1 of state machine design).
5. The restarted process re-observes current traffic state and creates a new attempt with a new `attempt_id` and new window before accepting any health result.

**Safety guarantee:** Late results from the abandoned attempt are rejected by the conditional write guard (completion status no longer matches `RUNNING`). The new attempt uses a new identity and follows the approved health-window rules.

### 8.4 Database outages

**Scenario:** PostgreSQL becomes unavailable during a critical operation (e.g., during a lifecycle transition or health result recording).

**Recovery:**
1. The worker cannot commit the transaction. The operation is not persisted.
2. The worker preserves the last committed state and does not make any lifecycle claim.
3. The worker cancels in-flight client work where possible and starts no more mutations.
4. After PostgreSQL recovers, the worker reloads state, re-observes external systems, and reconciles durable intent with actual state.
5. If the operation was a Kubernetes mutation that succeeded before the database outage, the worker observes the actual Kubernetes state and persists the acknowledgment.

**Safety guarantee:** No lifecycle transition or health result is accepted without a durable commit. The system remains in a conservative state until the database is available and state is reconciled.

### 8.5 Stale ALB observations

**Scenario:** The controller has an ALB observation that is no longer fresh (e.g., traffic configuration changed but the observation was not updated).

**Recovery:**
1. The controller marks `is_fresh = false` for stale observations when a newer observation supersedes them or when a configured freshness bound expires.
2. Before any promotion or success decision, the controller requires a fresh observation.
3. If no fresh observation exists, `traffic_safety` is set to `'UNKNOWN'` and no gate passes.
4. The controller re-observes the ALB state before proceeding.

**Safety guarantee:** Promotion and success decisions require fresh observations. Stale observations do not authorize unsafe transitions.

### 8.6 Rollback failures

**Scenario:** The controller attempts to roll back traffic but cannot verify that stable 100% / target 0% is restored (e.g., ALB observation fails or returns inconsistent state).

**Recovery:**
1. The controller remains in `ROLLING_BACK` while the configured retry/exhaustion policy permits.
2. If the rollback policy is exhausted without a fresh verification of stable 100% / target 0%, the controller transitions to `FAILED`.
3. The `FAILED` state retains the original canary failure reason and the rollback outcome.
4. `traffic_safety` is set to `'EXPOSED'` if the latest fresh observation still shows target traffic above zero, or `'UNKNOWN'` if current traffic cannot be determined.
5. The controller must not claim `VERIFIED_STABLE` without verification.

**Safety guarantee:** `ROLLED_BACK` is only transitioned to when stable 100% / target 0% is freshly verified. If verification cannot complete, the deployment ends in `FAILED` with appropriate `traffic_safety` (not falsely claiming restoration).

## 9. Open design decisions

The following decisions are deferred and require explicit resolution before implementation:

1. **Coordinator `owner_id` format:** The exact format of the coordinator owner identifier (process ID, UUID, host-based identifier) is not specified. It must be unique enough to distinguish different coordinator instances.

2. **Same-epoch worker liveness:** For same-epoch process initialization where health evaluation is performed by separate worker processes, the current architecture does not define a durable worker identity or liveness mechanism. The safe behavior is to not abandon another worker's `RUNNING` attempt without evidence that the attempt's owner is no longer active. If individual worker liveness tracking is required, an explicit architecture decision is needed to define worker identity, heartbeats, or liveness tracking.

3. **Observation freshness bound:** The configured freshness bound for traffic observations (how long an observation remains fresh before requiring re-observation) is a required configuration value, not defined in the schema.

4. **Lease duration and renewal interval:** The coordinator lease duration and renewal interval are required configuration values, not defined in the schema.

5. **Mutation timeout:** The maximum Kubernetes client timeout for mutations is a required configuration value, not defined in the schema.

6. **Health window duration:** The health evaluation window duration is a required configuration value, not defined in the schema.

7. **`health_evaluations.result` nullability:** Whether `result` should be made nullable to cleanly represent `RUNNING` attempts (see Section 3.2). This must be resolved before the migration is written.

8. **Health-observation structure:** The shape of the `observations` JSONB field in `health_evaluations` — field names, units, required vs. optional signals — must be defined before the Health Monitor integration is implemented.

9. **Duplicate-payload comparison for `deployment_events`:** If a caller replays an event (same deployment, same event type, same payload), the current schema does not prevent duplicate event rows. If idempotent event recording is required, a deduplication key or unique constraint must be defined.

## 10. Consistency with approved design

This schema design is derived from and consistent with:

- **`CONTROLLER_STATE_MACHINE_DESIGN.md`:** Implements the coordinator epoch fencing, health attempt abandonment protocol, traffic safety tracking, and Kubernetes/ALB observation requirements specified in Sections 1–9.
- **`ARCHITECTURE.md`:** Implements the deployment lifecycle state machine, stage sub-state protocol, and separation of lifecycle status from traffic safety specified in Section 8.
- **Safety invariants:** Preserves all safety invariants from Section 1 of the state machine design (conditional transitions, epoch fencing, revision checks, traffic safety separation).
- **Recovery protocol:** Implements the crash and restart recovery protocol from Section 5 of the state machine design.

No contradictions with the approved architecture or state machine design are introduced. Unresolved decisions are documented rather than guessed.

## Appendix A — Future upgrade scenario: adding these fields to a populated database

> **This appendix is not a requirement for the initial implementation.** It documents the migration procedure that would be required if this schema were being added to an existing database containing production rows. It is preserved here for reference should the system ever need to be deployed to an environment with pre-existing data.

### A.1 Staged backfill for `health_evaluations`

If in a future scenario this design were applied to a database with existing `health_evaluations` rows, the following staged approach would be required:

1. Add new columns as nullable: `attempt_id TEXT`, `completion TEXT`, `target_image TEXT`, `coordinator_epoch INTEGER DEFAULT 0`, `completed_at TIMESTAMP(3)`, `abandonment_reason TEXT`.
2. Backfill existing rows:
   ```sql
   UPDATE health_evaluations
   SET attempt_id = gen_random_uuid()::text,
       coordinator_epoch = 0,
       completion = 'COMPLETE',
       target_image = COALESCE(
           (SELECT target_image FROM deployments WHERE deployments.id = health_evaluations.deployment_id),
           'UNKNOWN_TARGET_IMAGE'
       )
   WHERE attempt_id IS NULL;
   ```
   For rows where the associated deployment no longer has a `target_image`, use `'UNKNOWN_TARGET_IMAGE'` as a sentinel. The controller treats attempts with this sentinel as invalid and does not use them for promotion decisions.
3. Enforce NOT NULL constraints in a separate migration step after verifying all rows are backfilled:
   ```sql
   ALTER TABLE health_evaluations ALTER COLUMN attempt_id SET NOT NULL;
   ALTER TABLE health_evaluations ALTER COLUMN coordinator_epoch SET NOT NULL;
   ALTER TABLE health_evaluations ALTER COLUMN completion SET NOT NULL;
   ALTER TABLE health_evaluations ALTER COLUMN target_image SET NOT NULL;
   ```

### A.2 Conservative backfill for `deployments.traffic_safety`

For all existing deployments, set `traffic_safety = 'UNKNOWN'`. Do not infer verified traffic state from lifecycle status alone.

- Non-terminal deployments enter the reconciliation loop and establish fresh observations before making promotion or rollback decisions.
- Terminal deployments (`SUCCEEDED`, `ROLLED_BACK`, `FAILED`) retain their lifecycle status with `traffic_safety = 'UNKNOWN'`; this is acceptable because terminal deployments require no further traffic decisions.

### A.3 Rollback safety with existing data

Dropping new columns when rows have been written loses newly collected information (traffic observations, attempt tracking). Rollback is not automatically lossless when data has been written. Staged migrations with application-layer dual-write compatibility may be required if rollback safety is critical in a production scenario.
