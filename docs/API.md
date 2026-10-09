# API Reference — Cloud-Native Deployment & Reliability Control Plane

## Overview

The Deployment API is the sole external interface for application registration and deployment orchestration. All endpoints are synchronous for request acceptance and state reads. Deployment execution is **asynchronous**: a successful deployment creation response means the request has been durably persisted; the controller discovers and reconciles it independently.

> [!IMPORTANT]
> **Authentication and authorization are intentionally deferred for the local MVP stage.** The architecture requires per-application authorization for all operations (see NFR-08, NFR-09), but the mechanism (JWT, API key, mTLS, etc.) is an implementation decision deferred to a later phase. In production, every operation listed here must be behind an authenticated and authorized boundary. Do not treat the current unauthenticated surface as production-ready.

---

## Common Response Conventions

### Success envelope

```json
{ "<resource>": { ... } }
```

### Error envelope

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description"
  },
  "requestId": "uuid"
}
```

Every response includes an `x-request-id` header. Supply `x-request-id: <uuid>` in your request to propagate your own identifier.

### Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Request body failed validation |
| `APPLICATION_NOT_FOUND` | 404 | Application identifier not found |
| `DEPLOYMENT_NOT_FOUND` | 404 | Deployment identifier not found |
| `DUPLICATE_APPLICATION_NAME` | 409 | Application name is already registered |
| `DUPLICATE_REQUEST` | 409 | Request identity already exists (returned with existing deployment) |
| `ACTIVE_DEPLOYMENT_CONFLICT` | 409 | Application already has a non-terminal deployment |
| `INTERNAL_SERVER_ERROR` | 500 | Unexpected failure — details are not exposed |

---

## Applications

### Register an Application

```
POST /applications
```

Registers a new application with the platform. The `name` becomes the stable, unique identifier for the application.

#### Request body

```json
{
  "name": "payments-api",
  "config": {
    "defaultReplicas": 3,
    "defaultPort": 3000
  }
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `name` | string | ✅ | 1–255 chars; `[a-zA-Z0-9][a-zA-Z0-9._-]*` |
| `config` | object | ❌ | Plain JSON object; must not contain secrets |

> [!WARNING]
> `config` must never contain secrets (passwords, tokens, private keys). Secret handling is deferred; store only non-sensitive configuration here.

#### Responses

| Status | Meaning |
|---|---|
| `201 Created` | Application registered |
| `400 Bad Request` | Validation failure |
| `409 Conflict` | Name already registered (`DUPLICATE_APPLICATION_NAME`) |

#### Example — success

```json
HTTP/1.1 201 Created

{
  "application": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "name": "payments-api",
    "config": { "defaultReplicas": 3 },
    "createdAt": "2026-09-30T09:00:00.000Z",
    "updatedAt": "2026-09-30T09:00:00.000Z"
  }
}
```

---

### Retrieve an Application

```
GET /applications/:applicationId
```

Returns the registered application and its configuration.

#### Path parameters

| Parameter | Description |
|---|---|
| `applicationId` | UUID returned from registration |

#### Responses

| Status | Meaning |
|---|---|
| `200 OK` | Application found |
| `404 Not Found` | Application not found (`APPLICATION_NOT_FOUND`) |

#### Example — success

```json
HTTP/1.1 200 OK

{
  "application": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "name": "payments-api",
    "config": {},
    "createdAt": "2026-09-30T09:00:00.000Z",
    "updatedAt": "2026-09-30T09:00:00.000Z"
  }
}
```

---

## Deployments

### Create a Deployment

```
POST /applications/:applicationId/deployments
```

Submits a deployment request for a registered application. The deployment is persisted immediately as `PENDING`; a background controller worker discovers and executes it asynchronously.

#### Idempotency

Supply a `requestIdentity` in the request body to make the call idempotent. Two requests with the **same** `requestIdentity` will always resolve to the **same logical deployment**:

- First call: creates and returns the deployment (`201`).
- Subsequent calls: returns the existing deployment (`200` or `201`).

If `requestIdentity` is omitted, the server generates a unique one — each call without an identity is treated as a new request.

#### Active-Deployment Protection

Only one **non-terminal** deployment may exist for an application at a time. Non-terminal statuses are: `PENDING`, `DEPLOYING`, `CANARY`, `VALIDATING`, `PROMOTING`, `CANARY_FAILED`, `ROLLING_BACK`.

A request that conflicts with an active deployment receives `409 ACTIVE_DEPLOYMENT_CONFLICT`. The caller must wait for the active deployment to reach a terminal state (`SUCCEEDED`, `FAILED`, or `ROLLED_BACK`) before submitting a new one.

> [!NOTE]
> The active-deployment check and deployment creation are executed in a single serializable PostgreSQL transaction. Concurrent requests for the same application are serialized at the database level — exactly one will succeed and the rest will receive `409`.

#### Atomic admission flow

```
HTTP Request
     ↓
Validate body
     ↓
BEGIN SERIALIZABLE TRANSACTION
     ↓
  SELECT … FROM applications WHERE id = ? FOR UPDATE  ← serialization point
     ↓
  Check request_identity uniqueness                   ← idempotency
     ↓
  Count non-terminal deployments for application      ← active-deployment check
     ↓
  INSERT deployment (revision = 0, status = PENDING)
     ↓
  INSERT deployment_events (DEPLOYMENT_CREATED)
COMMIT
     ↓
HTTP 201 response
```

#### Path parameters

| Parameter | Description |
|---|---|
| `applicationId` | UUID of the registered application |

#### Request body

```json
{
  "image": "123456789.dkr.ecr.ap-south-1.amazonaws.com/payments:v42",
  "replicas": 3,
  "port": 3000,
  "strategy": {
    "type": "canary",
    "steps": [10, 25, 50, 100]
  },
  "requestIdentity": "your-unique-idempotency-key",
  "stableImage": "123456789.dkr.ecr.ap-south-1.amazonaws.com/payments:v41"
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `image` | string | ✅ | Non-empty container image reference, max 512 chars |
| `replicas` | integer | ✅ | 1–100 |
| `port` | integer | ✅ | 1–65535 |
| `strategy` | object | ✅ | See below |
| `strategy.type` | string | ✅ | Must be `"canary"` |
| `strategy.steps` | integer[] | ✅ | 1–20 entries; each 1–100; must end with `100` |
| `requestIdentity` | string | ❌ | Max 255 chars; used for idempotency |
| `stableImage` | string | ❌ | Previous healthy image reference for rollback |

#### Responses

| Status | Meaning |
|---|---|
| `201 Created` | Deployment accepted and persisted |
| `400 Bad Request` | Validation failure |
| `404 Not Found` | Application not found |
| `409 Conflict` | Active deployment exists (`ACTIVE_DEPLOYMENT_CONFLICT`) or duplicate request resolved to existing deployment (`DUPLICATE_REQUEST`) |

#### Example — success

```json
HTTP/1.1 201 Created

{
  "deployment": {
    "id": "d1e2f3a4-b5c6-7890-def0-123456789abc",
    "applicationId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "requestIdentity": "your-unique-idempotency-key",
    "targetImage": "123456789.dkr.ecr.ap-south-1.amazonaws.com/payments:v42",
    "stableImage": "123456789.dkr.ecr.ap-south-1.amazonaws.com/payments:v41",
    "desiredReplicas": 3,
    "port": 3000,
    "strategy": { "type": "canary", "steps": [10, 25, 50, 100] },
    "status": "PENDING",
    "revision": 0,
    "currentStageIndex": null,
    "currentStage": null,
    "rollbackReason": null,
    "rollbackOutcome": null,
    "createdAt": "2026-09-30T09:00:00.000Z",
    "updatedAt": "2026-09-30T09:00:00.000Z",
    "completedAt": null
  }
}
```

#### Example — active deployment conflict

```json
HTTP/1.1 409 Conflict

{
  "error": {
    "code": "ACTIVE_DEPLOYMENT_CONFLICT",
    "message": "Application 'a1b2...' already has an active deployment. Only one non-terminal deployment is permitted per application."
  },
  "requestId": "..."
}
```

---

### Retrieve a Deployment

```
GET /deployments/:deploymentId
```

Returns the full deployment record including lifecycle state, version information, current traffic stage (desired vs observed), and rollback details where available.

> [!IMPORTANT]
> The `currentStage.desiredCanaryPct` field reflects the **intended** traffic percentage persisted by the controller. The `currentStage.observedCanaryPct` field reflects what the ALB/controller observation has **verified** as effective. When `observedCanaryPct` is `null`, traffic has not yet been confirmed at the data plane — do not treat `desiredCanaryPct` as the current actual routing state.

#### Path parameters

| Parameter | Description |
|---|---|
| `deploymentId` | UUID of the deployment |

#### Responses

| Status | Meaning |
|---|---|
| `200 OK` | Deployment found |
| `404 Not Found` | Deployment not found |

#### Traffic stage fields

| Field | Meaning |
|---|---|
| `currentStage.desiredCanaryPct` | Intended canary traffic % (PostgreSQL intent) |
| `currentStage.desiredStablePct` | Intended stable traffic % |
| `currentStage.appliedCanaryPct` | % written to Kubernetes Ingress spec |
| `currentStage.appliedStablePct` | % written to Kubernetes Ingress spec |
| `currentStage.observedCanaryPct` | % confirmed by ALB/controller observation (`null` = not verified) |
| `currentStage.observedStablePct` | % confirmed by ALB/controller observation (`null` = not verified) |

#### Deployment lifecycle states

| State | Description |
|---|---|
| `PENDING` | Accepted and persisted; controller has not started work |
| `DEPLOYING` | Controller creating/updating Kubernetes resources |
| `CANARY` | Target running alongside stable at initial canary traffic |
| `VALIDATING` | Health Monitor evaluating at current traffic stage |
| `PROMOTING` | Applying the next configured traffic stage |
| `SUCCEEDED` | Target at 100% traffic after all evaluations passed |
| `CANARY_FAILED` | A required health condition failed; promotion halted |
| `ROLLING_BACK` | Restoring traffic to the previous stable version |
| `ROLLED_BACK` | Previous version has verified 100% traffic |
| `FAILED` | Deployment or rollback could not complete |

---

### Retrieve Deployment Status

```
GET /deployments/:deploymentId/status
```

Lightweight read returning the current operational state without full deployment details. Useful for polling.

#### Path parameters

| Parameter | Description |
|---|---|
| `deploymentId` | UUID of the deployment |

#### Responses

| Status | Meaning |
|---|---|
| `200 OK` | Status returned |
| `404 Not Found` | Deployment not found |

#### Example — success

```json
HTTP/1.1 200 OK

{
  "status": {
    "id": "d1e2f3a4-b5c6-7890-def0-123456789abc",
    "applicationId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "status": "VALIDATING",
    "revision": 3,
    "targetImage": "123456789.dkr.ecr.ap-south-1.amazonaws.com/payments:v42",
    "stableImage": "123456789.dkr.ecr.ap-south-1.amazonaws.com/payments:v41",
    "currentStageIndex": 0,
    "desiredCanaryPct": 10,
    "observedCanaryPct": 10,
    "updatedAt": "2026-09-30T09:05:00.000Z"
  }
}
```

---

## Deferred Capabilities

The following are intentionally not implemented in this phase:

| Capability | Reason |
|---|---|
| Authentication / authorization | Mechanism deferred; API boundary is established but unenforced in local MVP |
| Deployment events endpoint | Will be added in the controller / observability phase |
| Deployment list endpoint | Not required for MVP acceptance |
| Kubernetes resource creation | Asynchronous controller responsibility |
| Traffic modification | Controller responsibility |
| Health evaluation | Health Monitor responsibility |
| Rollback | Rollback Manager responsibility |
