# System Architecture — Cloud-Native Deployment & Reliability Control Plane

## 1. Purpose and Architecture Summary

This document defines the component structure and interactions for the Cloud-Native Deployment & Reliability Control Plane. `PROBLEM_DEFINITION.md` and `REQUIREMENTS.md` are the sources of truth. This is an architecture description only; it does not define schemas, manifests, infrastructure configuration, or implementation code.

The MVP is a **modular monolith**: one platform application contains the Deployment API and background controller, with Health Monitor and Rollback Manager as internal modules. PostgreSQL stores durable state. Redis provides temporary coordination only. The controller continuously reconciles persisted desired deployment state against the observed Kubernetes and traffic state in EKS. Canary traffic is split using AWS Application Load Balancer (ALB) weighted target groups managed through Kubernetes Ingress and the AWS Load Balancer Controller integration.

## 2. System Overview and Boundaries

### Our platform

The platform owns application registration/configuration, deployment request handling, durable lifecycle state, Kubernetes resource reconciliation, canary stage progression, health-gated promotion, automatic rollback, controller recovery, and deployment status/events.

### External systems

GitHub, GitHub Actions, AWS ECR, AWS EKS/Kubernetes API, Prometheus, Grafana, and CloudWatch provide source control, CI/image storage, workload orchestration, metrics/visualization, and AWS observability. They are dependencies or operators of the platform; they do not own the control plane's deployment lifecycle state.

## 3. High-Level Architecture

```mermaid
flowchart LR
    Dev[Developer] --> GH[GitHub]
    GH --> GHA[GitHub Actions<br/>tests, security scan, build]
    GHA --> ECR[AWS ECR<br/>container images]
    Dev --> API[Deployment API]

    subgraph Platform[Deployment Platform — modular monolith]
        API --> PG[(PostgreSQL<br/>durable source of truth)]
        API --> CTRL[Deployment Controller]
        CTRL <--> PG
        CTRL <--> REDIS[(Redis<br/>temporary coordination)]
        CTRL --> HM[Health Monitor]
        CTRL --> RB[Rollback Manager]
        HM --> PROM[Prometheus]
        HM --> KAPI[Kubernetes API]
        RB --> KAPI
        CTRL --> KAPI
    end

    ECR -->|image pull by workload| EKS[AWS EKS]
    KAPI --> EKS
    subgraph Workloads[Application workloads in EKS]
        S1[Stable version v1<br/>Deployment + Service]
        S2[Canary version v2<br/>Deployment + Service]
    end
    EKS --> S1
    EKS --> S2
    ALB[AWS ALB<br/>weighted target groups] --> S1
    ALB --> S2
    KAPI -->|Ingress weights| ALB

    PROM --> GRAF[Grafana]
    EKS --> CW[CloudWatch]
    Platform -. platform logs/metrics .-> PROM
```

The flow is: Developer → GitHub → GitHub Actions → ECR → Deployment API/Platform → Kubernetes API/EKS → application workloads → health evaluation → promotion or rollback. CI publishes an image; a caller separately submits a deployment request referring to that image. The workload pulls the image from ECR. Traffic is sent to the stable and canary Services according to ALB target group weights.

## 4. Component Architecture

The initial platform is one deployable application with clear internal module boundaries. The API handles short request/response work. A background controller worker in the same application processes persisted non-terminal deployments. Health Monitor and Rollback Manager are internal modules called by the controller, not independent microservices. PostgreSQL and Redis are backing services. The Kubernetes API, Prometheus, and AWS services are external interfaces.

This keeps the MVP deployable and operable without unnecessary microservices while still allowing module boundaries to be tested and later separated if operational evidence justifies it. API and controller may run as different process roles from the same application package if needed for independent scaling; this is a deployment choice, not a requirement for separate services.

### Component responsibilities and contracts

| Component | Responsibility | Inputs | Outputs | Dependencies | Must not be responsible for |
|---|---|---|---|---|---|
| Deployment API (platform) | Authenticate/authorize calls; register and retrieve applications; accept deployments; expose status, details, events. | Caller requests and identity; application/deployment identifiers. | Accepted request/result; application/deployment representation and events. | PostgreSQL; platform authentication/authorization boundary. | Running CI, building/scanning images, directly controlling Kubernetes resources, or making health/promotion decisions. |
| Deployment Controller (platform) | Own lifecycle orchestration; derive desired state; observe and reconcile EKS/Kubernetes; coordinate health evaluation and rollback; recover work. | Persisted non-terminal deployment; Kubernetes observations; health result; configuration. | Kubernetes/Ingress desired changes; persisted transitions/events; promotion or rollback commands. | PostgreSQL, Redis coordination, Kubernetes API, Health Monitor, Rollback Manager. | Owning durable state in Redis, bypassing health gates, or treating an API request as successful deployment completion. |
| Health Monitor (platform module) | Collect and evaluate configured canary signals per stage; persist evaluation results. | Deployment/stage identity; configured thresholds/window; Prometheus observations; Kubernetes pod readiness/restart observations. | Pass/fail/indeterminate result and observations/reason. | Prometheus, Kubernetes API (or controller-provided observations), PostgreSQL. | Shifting traffic, changing deployment lifecycle independently, or inventing fixed production thresholds. |
| Rollback Manager (platform module) | Apply idempotent traffic restoration to previous healthy version and report outcome. | Failed deployment and previous/target versions; rollback reason; desired final weights. | Traffic configuration action; observed completion/outcome; rollback event/reason. | Kubernetes API/Ingress integration, PostgreSQL through controller. | Evaluating health, promoting a canary, or declaring rollback complete without observing restored traffic state. |
| PostgreSQL (platform dependency) | Durable source for application config, deployment intent/lifecycle/stages/events/evaluations/rollback data. | API writes and controller/monitor state changes. | Durable records read by API and recovery/controller. | Platform application. | Replacing Kubernetes as the source of actual workload state, or depending on Redis for durability. |
| Redis (platform dependency) | Temporary per-application controller coordination lease/lock to reduce duplicate simultaneous work. | Lock key/lease acquire, renew, and release requests. | Temporary lease result and expiry. | Redis service; PostgreSQL remains required to validate active deployment and record state. | Storing authoritative deployment state, lifecycle history, or a work item whose loss would lose a deployment. |
| GitHub (external) | Source control for application changes. | Developer commits. | Repository revisions and source. | Developer access. | Managing deployment state or changing production traffic. |
| GitHub Actions (external) | Run tests/security scans, build image, push image to ECR. | Repository event/workflow inputs. | CI results and image publication. | GitHub, build environment, ECR. | Orchestrating runtime canary stages or automatic rollback. |
| AWS ECR (external) | Store container images identified by deployment requests. | Image push from CI. | Image reference available for EKS workload pull. | AWS identity/permissions and network access. | Building the image or managing deployment lifecycle. |
| AWS EKS (external) | Host Kubernetes control plane and application workloads. | Kubernetes resource specifications and image pulls. | Running resources, pod status, cluster services. | AWS account/cluster infrastructure, ECR, Kubernetes API. | Deciding platform health policy or deployment lifecycle. |
| Kubernetes API (external interface) | Accept resource reads/writes for EKS; provide observed resource/pod state. | Controller/rollback resource operations. | Resource state and status. | EKS and controller credentials/RBAC. | Persisting platform business lifecycle/event history or independently promoting a deployment. |
| AWS ALB + AWS Load Balancer Controller (traffic integration) | Route client traffic to version Services using configured weighted target groups represented by Kubernetes Ingress. | Ingress and target group weight desired state. | Weighted routing to stable/canary Services; observable Ingress/target state. | EKS, Kubernetes API, AWS ALB integration and permissions. | Health evaluation or deciding whether a traffic step is safe. |
| Prometheus (external) | Supply measured HTTP error-rate and latency data and optionally receive platform metrics. | Workload/platform metric samples. | Time-window queries/observations. | Workload metrics instrumentation and scrape configuration; platform integration. | Making deployment transitions or serving as durable deployment state. |
| Grafana (external) | Visualize metrics supplied by Prometheus. | Metric queries/dashboard configuration. | Operator visualizations. | Prometheus. | Owning deployment state or controlling rollout. |
| CloudWatch (external) | AWS-side logs/metrics visibility for EKS and AWS resources as configured. | AWS/EKS telemetry. | Logs/metrics for operations. | AWS resource integration and permissions. | Replacing platform events or making canary decisions. |

Prometheus metric instrumentation and the exact CloudWatch/Grafana integrations are implementation decisions. They do not alter the platform's lifecycle ownership.

## 5. Deployment API

All operations that read or change application/deployment data are behind authentication and per-application authorization. Deployment creation is asynchronous: successful API acceptance means the request is persisted and identified, not that the workload is deployed. Read operations return current persisted status. Exact HTTP verbs, status codes, schemas, pagination format, and identity mechanism are deferred.

| Conceptual endpoint | Purpose | Request concept | Response concept | Auth boundary | Idempotency | Execution |
|---|---|---|---|---|---|---|
| Register application | Create an application record and store supplied config. | App identifier and application/deployment config. | Registered identifier and stored non-secret config. | Authenticated caller authorized to register/manage that application. | Repeated registration behavior must not create conflicting duplicate application records; exact key semantics deferred. | Synchronous persistence, then response. |
| Retrieve application | Read application information/configuration. | Application identifier. | Identifier and authorized, non-secret stored config. | Caller must be authorized for the application. | Read is naturally repeatable. | Synchronous read. |
| Create deployment | Persist a deployment request for an application and image. | Application, image reference, replicas, port, canary strategy/steps; request identity as needed. | Deployment identifier, accepted/current state, and link/identifier for status retrieval. | Caller must be authorized to deploy that application. | Same request retry identifies existing deployment and cannot create an independent duplicate. Conflicting active deployment is reported. | Synchronous validation/persistence; asynchronous controller execution. |
| Retrieve deployment | Read full deployment details. | Deployment identifier. | Application, image/current and target versions, state, stage/traffic, available health/rollback results and timestamps. | Caller must be authorized for the application. | Read is naturally repeatable. | Synchronous read. |
| Retrieve deployment status | Lightweight current state/traffic view. | Deployment identifier. | State, current/target version, canary percentage, updated timestamp. | Caller must be authorized for the application. | Read is naturally repeatable. | Synchronous read. |
| Retrieve deployment events | Diagnose lifecycle chronology. | Deployment identifier and optional pagination/cursor concept. | Timestamped lifecycle, health, traffic, and rollback events. | Caller must be authorized for the application. | Read is naturally repeatable. | Synchronous read. |

Secrets are excluded from responses and ordinary logs/events. API authorization decisions are made at the boundary and must apply consistently to all retrieval operations.

## 6. Deployment Controller and Reconciliation

The controller worker discovers non-terminal deployment records from PostgreSQL. It may poll for work; Redis is used only to coordinate temporary per-application worker ownership. The controller re-checks durable state after acquiring coordination and before side effects. It derives desired state from the accepted deployment request, current lifecycle state, completed evaluations/stages, and prior healthy version. It calls the Kubernetes API to observe relevant Deployments, Pods, Services, Ingress/ALB weights, and status, then compares those observations to the desired state.

**Desired state** is what the platform's persisted deployment intent says should exist now: the target version workload, intended replica count, active stable/canary versions, current traffic weights, and lifecycle stage.

**Actual state** is what the Kubernetes API and traffic integration report as currently present and routed: Deployment/Pod readiness and restarts, Services/endpoints, Ingress configuration, and applied ALB target group weights.

**Reconciliation** means observe actual state, compute the safe difference from desired state, issue idempotent corrective changes, observe again, and persist the result. The controller must not infer success merely from issuing a write. Promotion is allowed only after the current traffic configuration is observed and required health evaluation passes. During uncertainty (for example API unavailability or missing required metrics), it does not advance traffic.

The controller changes lifecycle state in PostgreSQL and appends an event around significant actions. Kubernetes operations may be repeated after a crash; they must be generated from persisted intent and verified state so they converge rather than creating logically new deployments.

## 7. Controller Reconciliation Loop

```mermaid
flowchart TD
    A[Load non-terminal deployment from PostgreSQL] --> B[Acquire temporary app coordination lease in Redis]
    B --> C[Reload and validate durable state]
    C --> D[Determine desired state from request, stage, events]
    D --> E[Observe Kubernetes resources and ALB traffic state]
    E --> F{Desired equals actual?}
    F -- No --> G[Issue idempotent corrective action]
    G --> H[Persist action/state event]
    H --> E
    F -- Yes --> I{Stage health evaluation required?}
    I -- Yes --> J[Health Monitor queries Prometheus and pod state]
    J --> K[Persist evaluation result]
    K --> L{Healthy?}
    L -- Yes --> M{Final stage?}
    M -- No --> N[Persist next stage intent]
    N --> D
    M -- Yes --> O[Persist SUCCEEDED]
    L -- No --> P[Persist CANARY_FAILED and reason]
    P --> Q[Rollback Manager restores stable traffic]
    Q --> R[Observe restored traffic and persist outcome]
    R --> S{Rollback verified?}
    S -- Yes --> T[Persist ROLLED_BACK]
    S -- No --> U[Persist FAILED with rollback failure]
    I -- No --> V[Persist state/event and wait/retry]
    V --> A
    O --> W[Release lease; terminal]
    T --> W
    U --> W
```

Each stage intent/evaluation is durable before moving to the next. On restart, the controller reloads that record and re-observes traffic; it cannot skip an unevaluated stage. Promotion is unsafe until Kubernetes/ALB actual state matches the stage being evaluated and the Health Monitor reports pass for all required configured conditions.

## 8. Deployment State Machine

```mermaid
stateDiagram-v2
    [*] --> PENDING
    PENDING --> DEPLOYING
    PENDING --> FAILED
    DEPLOYING --> CANARY
    DEPLOYING --> FAILED
    CANARY --> VALIDATING
    CANARY --> CANARY_FAILED
    CANARY --> FAILED
    VALIDATING --> PROMOTING: required signals pass
    VALIDATING --> CANARY_FAILED: configured condition fails
    VALIDATING --> FAILED: unrecoverable pre-rollback failure
    PROMOTING --> VALIDATING: next stage applied/observed
    PROMOTING --> SUCCEEDED: final 100% applied/observed
    PROMOTING --> CANARY_FAILED: failure observed before next stage
    PROMOTING --> FAILED: unrecoverable promotion failure
    CANARY_FAILED --> ROLLING_BACK
    ROLLING_BACK --> ROLLED_BACK: stable traffic restored and verified
    ROLLING_BACK --> FAILED: rollback cannot be completed
    SUCCEEDED --> [*]
    ROLLED_BACK --> [*]
    FAILED --> [*]
```

| State | Entry condition | Allowed actions | Valid transitions | Exit condition |
|---|---|---|---|---|
| `PENDING` | Request accepted and durably stored. | Validate conflict/idempotency; schedule controller work. | `DEPLOYING`, `FAILED`. | Work begins or pre-deployment validation/process failure is recorded. |
| `DEPLOYING` | Controller starts creating target workload resources. | Create/update target Deployment and supporting Service; observe pod readiness. | `CANARY`, `FAILED`. | Target is ready enough to enter canary, or deployment failure is recorded. |
| `CANARY` | Target and prior stable version coexist; initial below-100% weight is applied. | Observe applied weight; begin health evaluation. | `VALIDATING`, `CANARY_FAILED`, `FAILED`. | Stage is ready for validation, configured health failure is detected, or an unrecoverable deployment failure occurs. |
| `VALIDATING` | Health Monitor is evaluating the current applied traffic stage. | Gather configured signals; persist evaluation; wait/retry missing transient measurements without promotion. | `PROMOTING`, `CANARY_FAILED`, `FAILED`. | All required conditions pass; a configured condition fails; or unrecoverable failure occurs. |
| `PROMOTING` | A stage passed, and controller is applying the next weight (or final 100%). | Apply weight; observe actual Ingress/ALB and workload state; persist stage. | `VALIDATING`, `SUCCEEDED`, `CANARY_FAILED`, `FAILED`. | A non-final weight is observed and next validation begins; final 100% is observed; or failure is recorded. |
| `SUCCEEDED` | Target passed required stage evaluations and target receives 100%. | Read/emit status and terminal event. | None. | Terminal. |
| `CANARY_FAILED` | A required configured health condition failed. | Persist reason; prohibit further promotion; dispatch rollback. | `ROLLING_BACK`. | Rollback begins. |
| `ROLLING_BACK` | Rollback action is underway. | Idempotently set target to 0% and previous healthy version to 100%; observe result; retry/reconcile. | `ROLLED_BACK`, `FAILED`. | Restored traffic is verified or rollback failure is recorded. |
| `ROLLED_BACK` | Previous version has verified 100% traffic and target has 0%. | Read/emit terminal status and rollback details. | None. | Terminal. |
| `FAILED` | Deployment failed before normal completion, or rollback could not be completed. | Preserve failure/rollback detail; expose status for operator diagnosis. | None. | Terminal in this lifecycle; any later retry is a new request/deployment subject to conflict/idempotency rules. |

Invalid transitions include any transition out of `SUCCEEDED`, `ROLLED_BACK`, or `FAILED`; `PENDING` directly to canary/promotion/success; `VALIDATING` to `SUCCEEDED` without applying and observing the final 100% stage; `CANARY_FAILED` back to promotion/validation; and `ROLLING_BACK` back to canary/promotion. A health failure during an active pre-terminal stage must not transition to a later promotion stage.

## 9. PostgreSQL Responsibility and Conceptual Data Model

PostgreSQL is the durable source of platform intent and history. It stores application registrations/configuration, deployment requests and image references, lifecycle state, ordered stages and stage progress, timestamped deployment events, health evaluation observations/results, prior healthy/target version relationships, and rollback reason/outcome. These records must survive controller restart and provide the API's status view.

Conceptual relationships (not a schema):

- An **Application** has many **Deployments**.
- A **Deployment** belongs to one Application and identifies a target image/version and prior healthy version.
- A **Deployment** has ordered **Deployment Stages**, each representing an intended/applied traffic percentage and evaluation progress.
- A **Deployment** has timestamped **Deployment Events** documenting lifecycle and side effects.
- A **Deployment Stage** may have one or more **Health Evaluations** with signal observations and outcome.
- A **Deployment** may have **Rollback Information** including reason, attempted actions, and verified outcome.

Persisting intent and events here allows API reads and restart recovery without depending on controller memory. Kubernetes remains authoritative for actual resource state; the controller re-observes it and reconciles it with PostgreSQL intent.

## 10. Redis Responsibility

Redis is selected for **temporary per-application controller coordination leases**. A worker acquires a short-lived lease before acting on a deployment for that application, renews it while it owns the work, and releases it on completion. Expiry permits work to resume after a crashed worker. This reduces concurrent controller workers racing on the same application's stages.

Redis is not a queue of record and does not store deployment status, stage completion, health decisions, events, or rollback state. A lost/expired lease may cause another worker to re-check PostgreSQL and Kubernetes and repeat an idempotent reconciliation action; it cannot lose deployment intent. The controller must still validate durable active deployment state in PostgreSQL. Lease details/fencing mechanics are implementation decisions for database/implementation design.

**PostgreSQL = durable state. Redis = temporary coordination.**

## 11. Kubernetes and EKS Architecture

The controller manages application-scoped resources in EKS, with a Namespace boundary for each registered application (namespace naming and whether shared namespaces are permitted are implementation details). For each version it manages:

- A Kubernetes **Deployment** that specifies the requested image and replica count and creates the version's Pods.
- A version-specific **Service** selecting that version's ready Pods.
- An **Ingress** representing the application entry path and weighted routing to stable/canary Services, reconciled through the AWS Load Balancer Controller into ALB target groups.
- **Pods**, whose readiness and restart status are observed through the Kubernetes API.
- **Readiness probes** to determine whether a Pod can receive traffic, and **liveness probes** to allow Kubernetes to detect/restart a stuck container. Probe path/timing configuration is not present in the current request requirements and remains a configuration/implementation decision.
- **Resource requests and limits** on Pods. Values and defaulting policy are not specified by existing requirements and must be resolved during implementation configuration; this architecture does not invent numeric values.

During canary, the old version's Deployment and Service remain available while a separate new version Deployment and Service are created. The ALB receives traffic weights for both target groups. At promotion the new version receives 100%; after successful completion the old version may remain deployed or be cleaned up according to a retention policy, which is not defined in the requirements and remains an implementation decision. Rollback requires the previous healthy version and its Service to remain available through the active rollout.

The controller has narrowly scoped Kubernetes RBAC for required reads/writes in managed namespaces. EKS and Kubernetes schedule and restart Pods; the control plane observes those outcomes and decides whether the deployment may progress.

## 12. Canary Traffic Architecture (MVP Selection)

**Selected mechanism: AWS ALB weighted target groups, configured by Kubernetes Ingress and reconciled by the AWS Load Balancer Controller.** Each application version has a Kubernetes Service and a corresponding ALB target group. The Ingress traffic action assigns complementary weights to stable and canary target groups. The controller writes the desired stage weights through Kubernetes resources, then reads back Ingress/controller status and verifies the applied routing state before requesting health evaluation.

| Canary stage | Stable v1 weight | Target v2 weight |
|---:|---:|---:|
| Initial | 90% | 10% |
| Next | 75% | 25% |
| Next | 50% | 50% |
| Final | 0% | 100% |

On failure, rollback sets v1 to 100% and v2 to 0%, then observes the applied state before marking `ROLLED_BACK`.

This choice is appropriate because AWS ALB weighted target groups are an explicit candidate in the architecture brief, support routing between separate version backends, and avoid introducing a service mesh. Kubernetes Service alone does not define precise weighted splitting between two independent Services, so Service-only routing is not selected. This choice does depend on the AWS Load Balancer Controller integration and ALB availability/configuration in EKS; that dependency must be included in MVP implementation planning. The platform's configured percentages describe requested ALB weights; observed request proportions may vary with actual request volume and ALB behavior.

## 13. Health Monitor

The Health Monitor is an internal module called for the currently applied deployment stage. It obtains:

- **HTTP error rate and latency:** from time-windowed Prometheus queries for the stable and canary workload signals. Workload metric instrumentation and metric names are implementation decisions.
- **Pod readiness and restart failures:** from Kubernetes Pod/Deployment status via Kubernetes API observation, either fetched by the module or supplied by the controller.

For each stage, it evaluates over the configured observation window and compares each required signal with its configured condition/threshold. The canary passes only when every configured required signal passes. A failed required condition is unhealthy and is returned with observations and reason. Missing/unavailable required metrics are indeterminate, never a pass; the controller remains in `VALIDATING` and retries while data may recover, or follows the configured failure handling. No timeout or production threshold is invented here; configuring how long to wait before classifying unavailable metrics as deployment failure remains an implementation decision.

The Health Monitor persists the evaluation and associated stage/signal observations to PostgreSQL and returns the result to the controller. The controller owns lifecycle transitions. Grafana can visualize Prometheus data but is not in the decision path; CloudWatch may provide AWS operational visibility but does not replace required health evaluation unless that integration is later defined.

## 14. Promotion Flow

1. **Deploy target — Controller:** create target Deployment and Service alongside stable version.
2. **Target ready — Controller/Kubernetes:** observe readiness before routing canary traffic.
3. **Apply canary stage — Controller:** request ALB weight through Ingress and wait until actual routing configuration is observed.
4. **Evaluate — Health Monitor:** query configured HTTP error rate, latency, readiness, and restart signals; persist stage result.
5. **Decide — Controller:** on pass, persist next desired stage; on failure, persist `CANARY_FAILED` and dispatch rollback; on missing data, do not promote.
6. **Repeat:** apply and evaluate each subsequent stage.
7. **Complete — Controller:** once final 100% weight is observed after passing the final required evaluation, persist `SUCCEEDED` and emit event.

## 15. Rollback Flow

Canary → Health failure → `CANARY_FAILED` → stop promotion → `ROLLING_BACK` → Rollback Manager requests stable 100% / target 0% → controller/manager observe Ingress and target state → `ROLLED_BACK` when restored traffic is verified.

The failed health result/reason is persisted before or with rollback dispatch so that a crash cannot erase the reason. The rollback operation is idempotent: it repeatedly reconciles toward the same final weights. If Kubernetes/ALB cannot be brought to the restored state, the controller retries/reconciles while possible; if rollback is determined unable to complete, it records the rollback failure and transitions to `FAILED`, retaining original failure and rollback details. It must not report `ROLLED_BACK` until traffic restoration is verified.

## 16. Controller Crash Recovery

Scenario: controller starts deployment → v2 deployed → v2 at 10% → controller crashes → controller restarts → loads persisted state → observes Kubernetes/ALB → determines actual state → reconciles → continues safely.

The restart worker scans PostgreSQL for non-terminal deployments, acquires a temporary Redis lease, reloads the persisted lifecycle state/current stage and completed health evaluations, and observes Kubernetes state and traffic. It then computes the next action from durable intent and actual state:

- **No stage skipping:** the next stage cannot be persisted/applied until the current stage's health result is durably recorded as passing.
- **No incorrect repeat:** if the intended weight was applied before the crash, the controller observes it and continues validation rather than treating it as a new deployment or blindly applying a different stage. Reapplying the same desired resource state is safe reconciliation.
- **No duplicate deployment:** the original deployment record and request identity remain in PostgreSQL; retrying the request resolves to that record, and the per-application active-deployment check prevents another active rollout.
- **No lost rollback reason:** failure reason and `CANARY_FAILED`/rollback intent are persisted before rollback work. A restarted controller resumes `ROLLING_BACK` and verifies completion.
- **Lease recovery:** if the old worker died, its Redis lease expires; a new worker reloads durable state rather than relying on lease contents.

## 17. Failure Scenarios

| Scenario | Detection | Lifecycle state | Action and retry/reconciliation | Expected result |
|---|---|---|---|---|
| A. Application Pod crashes during canary | Kubernetes API reports readiness loss/restart; Health Monitor evaluates required pod signals. | Remains `VALIDATING` while evaluating; configured failure transitions to `CANARY_FAILED`; unrecoverable pre-canary workload failure may be `FAILED`. | Controller observes Kubernetes self-recovery/reconciliation; no promotion while required health fails; rollback follows if condition is unhealthy. | `ROLLED_BACK` after verified restoration if canary fails; otherwise resume stages only after health passes. |
| B. Health metrics indicate high error rate | Health Monitor's Prometheus query crosses configured error-rate condition. | `VALIDATING` → `CANARY_FAILED` → `ROLLING_BACK`. | Persist failed observation/reason; stop promotion; Rollback Manager applies stable 100%/canary 0%; retry reconciliation as needed. | `ROLLED_BACK` when traffic restoration is verified; `FAILED` if rollback cannot complete. |
| C. Controller crashes during validation | Process restart; durable non-terminal record remains in PostgreSQL. | Persisted `VALIDATING` (or last committed state). | Replacement worker loads evaluation/stage, observes actual weight and pods, safely resumes/repeats incomplete query; does not advance without recorded pass. | Continue to next stage on pass, or failure/rollback path on fail. |
| D. Controller crashes during rollback | Restart finds persisted `ROLLING_BACK` and rollback reason. | `ROLLING_BACK`. | New worker observes current weights and repeats idempotent restore action; verifies result. | `ROLLED_BACK` after verification or `FAILED` with retained rollback details if unable to complete. |
| E. Duplicate deployment request | API idempotency lookup and active deployment check in PostgreSQL. | Existing deployment state unchanged. | Return/identify existing request outcome; do not dispatch independent deployment. | One deployment record and one active rollout. |
| F. Kubernetes API temporarily unavailable | Controller/API call failure and inability to observe/apply resources. | Preserve current non-terminal state; do not mark success or promote. If terminal inability is established, `FAILED`. | Retry observation/reconciliation with backoff policy determined in implementation; preserve intent in PostgreSQL. | Resume from observed state after API recovers; otherwise `FAILED` with cause recorded if recovery cannot complete. |
| G. Required health metric unavailable | Health Monitor query returns missing/unavailable required data. | `VALIDATING`. | Return indeterminate, record availability issue, prevent promotion, retry while recoverable; timeout/failure policy is deferred. | Continue only when required signals are available and pass; if classified as a deployment failure, stop and roll back. |

For temporary dependency failures, the architecture preserves durable state and retries/reconciles; precise retry limits/backoff and classification of prolonged outages are implementation decisions.

## 18. Data Flow

### Successful deployment

```mermaid
sequenceDiagram
    actor Developer
    participant GitHub
    participant Actions as GitHub Actions
    participant ECR
    participant API as Deployment API
    participant PG as PostgreSQL
    participant Controller
    participant K8s as Kubernetes API / EKS
    participant ALB as ALB weighted routing
    participant Monitor as Health Monitor
    participant Prom as Prometheus

    Developer->>GitHub: Commit application change
    GitHub->>Actions: Trigger CI workflow
    Actions->>Actions: Test, scan, build image
    Actions->>ECR: Push image
    Developer->>API: Create deployment referencing image
    API->>PG: Persist deployment as PENDING
    API-->>Developer: Return deployment identifier/status
    Controller->>PG: Load non-terminal deployment
    Controller->>K8s: Create target Deployment and Service
    K8s-->>Controller: Report ready Pods
    Controller->>K8s: Configure Ingress/ALB canary weights
    Controller->>ALB: Wait/observe applied routing
    loop Each configured stage
        Controller->>Monitor: Evaluate deployment stage
        Monitor->>Prom: Query HTTP error rate and latency window
        Prom-->>Monitor: Metric observations
        Monitor->>K8s: Readiness/restart observations
        K8s-->>Monitor: Pod state
        Monitor->>PG: Persist evaluation result
        Monitor-->>Controller: Pass result
        Controller->>PG: Persist next stage intent/event
        Controller->>K8s: Apply next Ingress weights
    end
    Controller->>PG: Persist SUCCEEDED at observed 100%
```

### Failed deployment and rollback

```mermaid
sequenceDiagram
    participant Controller
    participant Monitor as Health Monitor
    participant Prom as Prometheus
    participant PG as PostgreSQL
    participant Rollback as Rollback Manager
    participant K8s as Kubernetes API / EKS
    participant ALB as ALB weighted routing

    Controller->>Monitor: Evaluate current canary stage
    Monitor->>Prom: Query configured error/latency metrics
    Prom-->>Monitor: Failing observation
    Monitor->>PG: Persist failed evaluation
    Monitor-->>Controller: Unhealthy + reason
    Controller->>PG: Persist CANARY_FAILED and rollback intent
    Controller->>PG: Persist ROLLING_BACK
    Controller->>Rollback: Restore previous stable version
    Rollback->>K8s: Set Ingress weights: stable 100%, canary 0%
    K8s->>ALB: Reconcile target group weights
    ALB-->>K8s: Applied routing status
    K8s-->>Rollback: Observe restored traffic configuration
    Rollback->>PG: Persist rollback outcome/event
    Rollback-->>Controller: Verified or failed outcome
    alt Traffic restored
        Controller->>PG: Persist ROLLED_BACK
    else Rollback cannot complete
        Controller->>PG: Persist FAILED with rollback details
    end
```

## 19. Security Boundaries

- **Deployment API:** authenticate every caller and authorize application-scoped operations. Enforce authorization on registration, creation, retrieval, status, and event access.
- **AWS IAM:** platform AWS identity is limited to required AWS interactions, including EKS/ALB integration as applicable. Exact role/policy is deferred.
- **Kubernetes RBAC:** controller identity can only perform required resource operations in managed namespaces; no broad cluster-admin permission is assumed.
- **Secrets:** credentials and sensitive application configuration are never returned by APIs or written in ordinary events/logs. Secret storage/injection is not selected in this architecture.
- **ECR:** deployment references an ECR image; AWS permissions control image push/pull. CI scans images in the existing GitHub Actions flow; this control plane does not replace that scan.
- **PostgreSQL:** access is restricted to platform components that require durable records; credentials are treated as secrets. Exact network/auth configuration is deferred.
- **Redis:** access is restricted to controller coordination use; it contains temporary lease data only, no durable or sensitive deployment payload. Exact access configuration is deferred.
- **Prometheus/Grafana/CloudWatch:** access is limited to required metric/log queries and visualization. Secrets must not be included in exported telemetry.

Authentication technology, authorization policy model, credential delivery, network boundaries, encryption settings, and exact IAM/RBAC rules remain implementation decisions.

## 20. Architecture Decisions (ADR-style)

### ADR-01 — Start as a modular monolith

- **Decision:** Deployment API, Controller, Health Monitor, and Rollback Manager are modules of one platform application; controller work runs asynchronously in a worker role.
- **Reason:** The MVP needs coordinated state transitions and does not require independently deployable microservices. The brief excludes unnecessary microservices.
- **Trade-off:** Modules share a release and may share runtime/resource limits; later separation requires evidence and explicit design work.

### ADR-02 — PostgreSQL is durable source of truth

- **Decision:** Persist applications, requests, lifecycle/stages, events, health results, and rollback information in PostgreSQL.
- **Reason:** API visibility and restart recovery require durable, queryable records.
- **Trade-off:** The controller must manage database availability and reconcile database intent with Kubernetes actual state; PostgreSQL is not a substitute for observing the cluster.

### ADR-03 — Redis provides temporary coordination only

- **Decision:** Use Redis leases for per-application controller worker coordination, not deployment state or event durability.
- **Reason:** It can reduce simultaneous work while keeping recovery anchored in PostgreSQL.
- **Trade-off:** Leases can expire or Redis can be unavailable; workers must re-check PostgreSQL and make side effects idempotent. The system must not lose deployment intent when Redis is lost.

### ADR-04 — Kubernetes/EKS runs application workloads

- **Decision:** Use Kubernetes API via AWS EKS for desired workload resources and actual workload observations.
- **Reason:** Kubernetes/EKS is the orchestration environment named by the problem definition and supports the required real workload demonstration.
- **Trade-off:** The platform depends on cluster/API availability and must handle Kubernetes reconciliation and permission boundaries.

### ADR-05 — Use progressive canary deployment

- **Decision:** Run stable and target versions concurrently, route through configured stages, gate every increase on health, then promote or automatically roll back.
- **Reason:** This is the project's core safety objective and required success/failure behavior.
- **Trade-off:** Both versions and their resources must coexist during rollout; traffic configuration and measurements must be observable and reliable.

### ADR-06 — Use ALB weighted target groups for MVP traffic splitting

- **Decision:** Set stable/canary percentages using AWS ALB weighted target groups configured through Ingress and the AWS Load Balancer Controller integration.
- **Reason:** It is an explicit option in the architecture brief, supports weighted routing between two Services, and avoids adding a service mesh.
- **Trade-off:** Adds dependence on ALB and its Kubernetes integration; observed request percentages can differ from configured weights due to request distribution. EKS MVP setup must support this integration.

### ADR-07 — Use reconciliation, not a one-shot deployment script

- **Decision:** Persist desired intent, repeatedly observe actual Kubernetes/traffic state, and idempotently reconcile until terminal outcome.
- **Reason:** Controller restarts and partial Kubernetes operations must recover without losing progress, skipping stages, or falsely reporting success.
- **Trade-off:** Requires explicit lifecycle/stage persistence, repeated reads, idempotent writes, and careful handling of temporarily unavailable dependencies.

### ADR-08 — Prometheus supplies service health signals

- **Decision:** Health Monitor reads HTTP error-rate and latency measurements from Prometheus and pod health from Kubernetes API observations.
- **Reason:** Prometheus is named in the architecture boundary and supplies time-series measurements needed for stage evaluation.
- **Trade-off:** Workload instrumentation and metric query definitions must be configured; missing data blocks promotion and needs a deferred timeout policy.

## 21. Architecture Constraints

1. PostgreSQL is the durable source of deployment state.
2. Redis must not become the authoritative deployment state store.
3. The controller must reconcile desired and actual Kubernetes state.
4. Deployment promotion must be health-gated.
5. Failed canaries must automatically roll back.
6. Controller restart must not lose non-terminal deployment state.
7. The MVP must not depend on unnecessary infrastructure.
8. No microservice decomposition is introduced without engineering justification.
9. No service mesh is introduced unless requirements justify it.
10. This phase creates no implementation code.

## 22. Definition of Done

- Every functional and non-functional requirement has an architectural owner or is identified as a cross-cutting constraint.
- Every core platform component and named external system has a responsibility, inputs, outputs, dependencies, and explicit non-responsibilities.
- Deployment API concepts and async behavior are described.
- Lifecycle, valid/invalid transitions, promotion, rollback, and crash recovery are represented.
- Desired and actual state and the reconciliation loop are explicit.
- PostgreSQL and Redis roles are distinct and clear.
- One MVP traffic-splitting mechanism is selected and justified.
- Kubernetes workload/version coexistence, probes, and resource requests/limits are addressed without inventing numeric settings absent from requirements.
- Major failure scenarios A–G have detection, state, action/recovery, and expected result documented.
- Successful and failed data flows and security boundaries are represented.
- Major architecture decisions include decision, reason, and trade-off.

## 23. Requirements Not Yet Fully Resolved by This Architecture

The architecture defines the main structure, but several requirements need implementation-level decisions before they can be fully realized or verified:

- `REQUIREMENTS.md` names Redis without a role; this document assigns it temporary worker coordination. Lease fencing/expiry specifics remain open.
- The deployment request does not define readiness/liveness probe parameters or resource request/limit values. The workload architecture includes these concepts, but defaults and required configuration must be settled before implementation.
- Prometheus metric names, workload instrumentation, evaluation window values, health thresholds, and missing-metric timeout/failure policy are unspecified by requirements and remain configurable/deferred.
- The ALB weighted target group approach requires an AWS Load Balancer Controller integration and appropriate EKS/ALB setup. The existing requirements do not expressly list that integration as a component; it is the selected mechanism's necessary dependency and must be accepted in MVP implementation planning.
- Exact API schemas/status codes, idempotency identity, authentication/authorization mechanisms, IAM/RBAC rules, secret storage, retry/backoff policy, old-version retention, and PostgreSQL recovery/retention targets remain implementation decisions.

These open details do not change the architecture's ownership boundaries, durable state model, health gate, or recovery model.
