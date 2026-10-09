# Database Design — Cloud-Native Deployment & Reliability Control Plane

## 1. Overview

PostgreSQL is the authoritative durable state store for the control plane. The schema is managed by Prisma Migrate. Redis is **not used** in the MVP; all serialization, idempotency, and recovery are backed by PostgreSQL.

## 2. Entities and Responsibilities

### Application
Represents a deployable workload registered with the platform. Stores a human-readable `name` (unique) and a non-secret JSON `config` blob for default deployment settings. Secrets must never be stored in `config`; secret storage is deferred to a future secrets-management integration.

### Deployment
Represents one requested rollout for an application. Owns the lifecycle state machine, revision/fencing counter, traffic strategy, version references, and rollback information.

### DeploymentStage
Represents one ordered canary step within a deployment. Persists the full `persist-intent → side-effect → observe → acknowledge` protocol via the `StageStatus` sub-state and separate desired/applied/observed traffic columns.

### HealthEvaluation
Represents one evaluation produced by the Health Monitor for a deployment + stage + revision + time window. The `observations` JSON stores signal values (error rate, latency, pod readiness). The controller discards any evaluation whose `deploymentRevision` does not match the current revision.

### DeploymentEvent
Append-only audit log entries. Never updated or deleted. Provide a full diagnostic history for a deployment without exposing secrets.

## 3. Relationships

```
Application (1) ──── (N) Deployment
Deployment  (1) ──── (N) DeploymentStage
Deployment  (1) ──── (N) HealthEvaluation
Deployment  (1) ──── (N) DeploymentEvent
DeploymentStage (1) ─── (N) HealthEvaluation
```

## 4. Important Invariants

### Application name uniqueness
Enforced by a `UNIQUE` constraint on `applications.name`. The platform uses the name as the stable caller-supplied identifier.

### Deployment request idempotency
The `deployments.request_identity` column carries a `UNIQUE` constraint. Two concurrent INSERT statements with the same `request_identity` will produce one row and one constraint violation. The winner returns the created deployment; the loser reads the existing row. No `SELECT-then-INSERT` pattern is used.

### Active deployment protection
There is no purely declarative Postgres constraint that expresses "at most one non-terminal deployment per application" because the set of terminal statuses is determined by application logic. The enforcement mechanism is:
1. The controller/API opens a serialised transaction and issues `SELECT ... FOR UPDATE` on the `applications` row for the target application.
2. It then counts non-terminal `deployments` rows for that application.
3. If zero, it inserts the new deployment and releases the lock; otherwise it returns a conflict error.
4. The composite index `idx_deployments_by_app_status` makes this count query efficient.

This is documented, not automated by the schema alone.

### Revision / fencing
Every `Deployment` has a monotonic `revision` integer starting at 0. Every lifecycle transition must use a conditional update:
```sql
UPDATE deployments
SET    status = $newStatus, revision = revision + 1
WHERE  id = $id AND revision = $expectedRevision
```
If `rowsAffected = 0`, the worker's revision is stale and it must reload the deployment before retrying. No stale worker can mutate the current deployment state. The controller logic that checks the affected row count is not in the schema but is documented here as the required pattern.

## 5. Stage Lifecycle

Each `DeploymentStage` progresses through the following `StageStatus` values:

```
UNEVALUATED → INTENT_RECORDED → APPLYING → APPLIED → VALIDATING → PASSED
                                                                  → FAILED
```

The `operationId` and `operationRevision` columns allow the controller to detect whether an external operation (Ingress/ALB write) was already initiated under the current revision before issuing a duplicate write. On restart, the controller observes actual ALB state first, then decides whether to retry or acknowledge the existing state.

The three traffic column groups encode the distinction required by the architecture:
- **desired**: PostgreSQL intent (what the controller wants the ALB to be set to)
- **applied**: what was written to the Kubernetes Ingress spec
- **observed**: what the ALB/controller observation confirmed as effective

## 6. Health Evaluation Persistence

Each `HealthEvaluation` is bound to `deploymentId + stageId + deploymentRevision + windowStart/windowEnd`. The controller only accepts a result if the current deployment revision still matches `deploymentRevision`. The `isFresh` flag is set to `false` by the controller before persisting a superseding evaluation for the same stage, enabling historical queries without confusion about which result was actionable.

The `observations` JSON column stores signal values without prescribing metric names (those are Prometheus/Health Monitor implementation details).

## 7. Event History

Deployment events are append-only: once written, a row is never updated or deleted. The `payload` JSON stores context (stage index, traffic percentages, failure reason) but must never include secrets. Events support chronological reconstruction of a deployment's lifecycle for operator diagnosis.

## 8. Transaction Boundaries

### Deployment creation (admission + idempotency)
```
BEGIN
  SELECT ... FOR UPDATE ON applications WHERE id = $applicationId
  Count non-terminal deployments for applicationId
  If count > 0 → ROLLBACK; return conflict
  INSERT INTO deployments (request_identity = $identity, ...)
    -- unique constraint on request_identity deduplicates concurrent retries
  INSERT INTO deployment_events (DEPLOYMENT_CREATED)
COMMIT
```

### Stage transition (revision-checked)
```
BEGIN
  UPDATE deployments SET status = $next, revision = revision + 1
  WHERE id = $id AND revision = $expected AND status = $currentExpected
  -- check rowsAffected; if 0 → ROLLBACK and reload
  INSERT INTO deployment_stages (...) or UPDATE deployment_stages ...
  INSERT INTO deployment_events ($eventType)
COMMIT
```

### Health result persistence + lifecycle transition
```
BEGIN
  INSERT INTO health_evaluations (...)
  UPDATE deployments SET status = $next, revision = revision + 1
  WHERE id = $id AND revision = $expected
  INSERT INTO deployment_events (HEALTH_VALIDATION_PASSED | FAILED)
COMMIT
```

## 9. Index Rationale

| Index | Columns | Purpose |
|---|---|---|
| `uq_applications_name` | `applications.name` | Uniqueness; application lookup by name |
| `uq_deployments_request_identity` | `deployments.request_identity` | Idempotency constraint; fast lookup by idempotency key |
| `idx_deployments_by_app_status` | `deployments.(application_id, status)` | Controller finds active/non-terminal deployments per app |
| `idx_deployments_by_app` | `deployments.(application_id, created_at DESC)` | API fetches most-recent deployment for an application |
| `uq_stage_per_deployment` | `deployment_stages.(deployment_id, stage_index)` | Prevents duplicate stage indices; fast stage lookup |
| `idx_stages_by_deployment` | `deployment_stages.(deployment_id, stage_index)` | Controller loads ordered stages for a deployment |
| `idx_health_evals_by_stage` | `health_evaluations.(deployment_id, stage_id, created_at DESC)` | Health Monitor finds most-recent evaluation for a stage |
| `idx_health_evals_by_revision` | `health_evaluations.(deployment_id, deployment_revision)` | Stale-result detection by revision |
| `idx_events_by_deployment` | `deployment_events.(deployment_id, occurred_at)` | Chronological event retrieval for a deployment |
| `idx_events_by_type` | `deployment_events.(event_type, occurred_at DESC)` | Cross-deployment queries by event type |

## 10. What Is Intentionally Deferred

- **Secret storage:** Application `config` must not contain secrets. The mechanism for secret injection (e.g. Kubernetes Secrets, AWS Secrets Manager) is deferred.
- **Authentication/authorization:** Schema does not encode caller identity or ownership. API-layer enforcement is a future step.
- **Prometheus metric names and health signal schema:** The `observations` JSON is intentionally schemaless at the database level.
- **Retry/failure policy values:** Attempt counts and durations are configurable; no fixed values are encoded in the schema.
- **Redis:** Explicitly excluded from MVP. Reconsider only after a concrete concurrency need is established.
- **Backup/retention:** Deferred to infrastructure configuration.
- **Kubernetes resource identity columns:** Not needed in the domain model until the controller implementation step.
