# Requirements — Cloud-Native Deployment & Reliability Control Plane

## 1. Purpose and Conventions

This document converts `PROBLEM_DEFINITION.md` into testable functional and non-functional requirements for the control plane. It defines required behavior, not an implementation design. Items explicitly described as initial engineering targets are provisional and must not be treated as measured benchmarks or production commitments.

Words such as **must** indicate requirements. Health thresholds and evaluation windows are configurable; this document does not assign production values to them.

## 2. Functional Requirements

### Application Management

**FR-01 — Register an application.** The Deployment API must allow a caller to register an application with an application identifier.

**FR-02 — Store application configuration.** The platform must persist the configuration supplied for a registered application, including the configuration needed to identify its deployment settings, such as replicas and port when provided.

**FR-03 — Retrieve application information.** The Deployment API must return a registered application's identifier and stored configuration when requested.

### Deployment Management

**FR-04 — Create a deployment.** The Deployment API must accept a deployment request identifying an application, container image, replicas, port, and deployment strategy, including canary steps.

**FR-05 — Associate a deployment with an image version.** Each deployment must persist the requested container image reference so that its target version is identifiable.

**FR-06 — Persist deployment state.** The platform must persist each accepted deployment's state and information required to continue or recover that deployment.

**FR-07 — Track deployment status.** The platform must update a deployment's state as it moves through its lifecycle and make the current state retrievable.

**FR-08 — Retrieve deployment details.** The Deployment API must return a deployment's application, image/target version, state, traffic stage, and recorded health and rollback information when available.

**FR-09 — Prevent conflicting deployments.** The platform must not run conflicting active deployments for the same application. A request that conflicts with an active deployment must be rejected or otherwise reported without starting a second independent deployment.

**FR-10 — Make deployment requests idempotent.** Retrying the same deployment request must not create duplicate independent deployments. The caller must be able to identify the existing result of a repeated request. The request identity mechanism is an implementation decision.

### Deployment Controller and Reconciliation

**FR-11 — Create Kubernetes resources.** For an accepted deployment, the Deployment Controller must create or update the Kubernetes resources needed to run the requested application version.

**FR-12 — Track desired state.** The controller must track the desired deployment state derived from the accepted request and current deployment phase.

**FR-13 — Observe actual state.** The controller must observe relevant Kubernetes resource and pod state for the deployment.

**FR-14 — Reconcile state.** When actual Kubernetes state differs from desired state, the controller must reconcile the difference toward the desired state or record a failure that prevents unsafe promotion.

**FR-15 — Recover controller work.** After a controller failure or restart, the controller must load persisted deployment state, observe Kubernetes state, and resume or reconcile the deployment without losing its recorded progress.

### Canary Deployment

**FR-16 — Run versions side by side.** The platform must deploy the target version alongside the currently healthy version during a canary rollout.

**FR-17 — Apply initial canary traffic.** The platform must begin with a configured canary traffic percentage, below 100%, while retaining traffic on the previous healthy version.

**FR-18 — Support progressive stages.** The platform must accept and apply configured progressive traffic stages in order, ending at 100% for successful promotion. For the documented success scenario, stages are 10%, 25%, 50%, and 100%.

**FR-19 — Pause for health evaluation.** Before advancing from a canary traffic stage, the platform must allow health evaluation at that stage. The evaluation duration/window is configurable; no fixed duration is prescribed here.

**FR-20 — Promote a healthy deployment.** When the target version meets configured health conditions at each required stage, the platform must advance traffic through the configured stages and mark the deployment `SUCCEEDED` after the target reaches 100% traffic.

**FR-21 — Stop an unhealthy deployment.** When health evaluation finds the canary unhealthy, the platform must stop further traffic promotion and initiate the failure/rollback path.

### Health Evaluation

**FR-22 — Evaluate configured health signals.** The Health Monitor must evaluate canary HTTP error rate, latency, pod readiness, and pod restart failures using available measurements.

**FR-23 — Determine canary health.** For each signal, the platform must compare observations over the configured evaluation window with its configured health condition/threshold. The canary is healthy only when all configured required conditions pass; it is unhealthy when any configured required condition fails. Missing or unavailable required measurements must not be treated as a passing condition and must prevent promotion until resolved or handled as a failure. Threshold values and evaluation windows are configuration, not fixed production values in this specification.

**FR-24 — Record evaluation results.** The platform must associate each health evaluation with the deployment and traffic stage and make its signal observations and pass/fail result available for diagnosis.

### Automatic Rollback

**FR-25 — Detect canary failure.** When a canary fails a configured health condition, the platform must record the failed condition and identify the deployment as canary-failed.

**FR-26 — Halt promotion on failure.** Once canary failure is detected, the platform must not advance the canary to another traffic stage.

**FR-27 — Restore previous-version traffic.** The Rollback Manager must restore 100% of traffic to the previous healthy version and set the failed target version's traffic to 0%.

**FR-28 — Record rollback outcome and reason.** The platform must persist the rollback reason and outcome and expose them with deployment details.

**FR-29 — Mark completed rollback.** When traffic has been restored successfully, the platform must mark the deployment `ROLLED_BACK`.

**FR-30 — Make rollback idempotent.** Repeated rollback requests or events for the same deployment must not create duplicate independent rollback actions or leave traffic in a different final state.

### Deployment State and Failure Recovery

**FR-31 — Enforce the deployment lifecycle.** The platform must use the following lifecycle states and only allow transitions consistent with the deployment process:

- `PENDING` — accepted and persisted; work has not started.
- `DEPLOYING` — creating/updating Kubernetes resources and waiting for target pods to become ready.
- `CANARY` — target is running alongside the previous version and has a canary traffic stage.
- `VALIDATING` — collecting/evaluating health at the current stage.
- `PROMOTING` — applying the next traffic stage after a passing evaluation; return to `VALIDATING` for evaluation at that stage.
- `SUCCEEDED` — target has passed required evaluations and receives 100% of traffic.
- `CANARY_FAILED` — canary failed a configured health condition; promotion is stopped.
- `ROLLING_BACK` — restoring traffic to the previous healthy version.
- `ROLLED_BACK` — rollback completed and previous version has 100% of traffic.
- `FAILED` — deployment failed before a canary rollback path can complete, or rollback itself could not complete; failure details must be recorded.

Expected success path: `PENDING` → `DEPLOYING` → `CANARY` → `VALIDATING` → `PROMOTING` → `VALIDATING` (repeated for stages) → `SUCCEEDED`.

Expected canary failure path: `...` → `CANARY_FAILED` → `ROLLING_BACK` → `ROLLED_BACK`. A failure to complete rollback transitions to `FAILED` and retains the failure and rollback details. A deployment that fails before canary evaluation may transition to `FAILED`.

**FR-32 — Recover after a pod crash.** If a target pod crashes, the controller must observe the resulting Kubernetes state. The health monitor must treat readiness or restart conditions according to configured health conditions; the platform must not promote while required health conditions fail. The platform must reconcile the desired workload state or initiate the failure path based on the observed/configured outcome.

**FR-33 — Recover interrupted canary processing.** If processing is interrupted during a canary stage, the controller must recover the persisted deployment and stage, observe actual traffic and Kubernetes state, then resume evaluation or reconciliation without skipping an unevaluated stage or repeating a completed stage as a new deployment.

**FR-34 — Handle deployment retries.** If a deployment request is retried, the platform must apply FR-10 and return or identify the existing deployment outcome. It must not start another independent deployment.

### Observability

**FR-35 — Expose deployment status and versions.** The platform must expose deployment state, current version, target version, and current canary traffic percentage.

**FR-36 — Record deployment events and timestamps.** The platform must record deployment lifecycle events with timestamps sufficient to reconstruct the sequence of state changes and traffic stages.

**FR-37 — Expose health and rollback details.** The platform must expose health evaluation results, relevant error-rate and latency observations, pod health, and rollback reason/outcome.

## 3. Non-Functional Requirements

**NFR-01 — Reliability and controller recovery.** A controller restart must not erase accepted deployment state. Following restart, the controller must be able to recover each non-terminal deployment and reconcile it as required by FR-15.

**NFR-02 — Idempotent event handling.** Reprocessing the same deployment or rollback event must not create a duplicate deployment, advance traffic twice for one stage, or execute a rollback into a conflicting final state.

**NFR-03 — Eventual state consistency.** After Kubernetes changes stop and the controller has completed reconciliation, the platform's recorded desired/current deployment state must reflect the observed Kubernetes workload and traffic state, or identify a failure to reconcile.

**NFR-04 — Control-plane availability during workload failure.** Failure of an application's pods must not by itself prevent callers from retrieving deployment status or submitting requests for other applications, provided the control plane and its dependencies remain available. This requirement does not prescribe an uptime percentage.

**NFR-05 — API response time (initial engineering target).** For application/deployment read operations and deployment request acceptance, target a response time of at most 500 ms at the 95th percentile under the initial MVP load. This is a provisional engineering target, not a measured benchmark or production SLO. Long-running deployment execution is asynchronous and is not required to finish within this response time.

**NFR-06 — Controller processing time (initial engineering target).** Under the initial MVP load, target controller reaction to a newly persisted request or observed state change within 30 seconds at the 95th percentile, excluding configured health evaluation windows and external Kubernetes/API unavailability. This is a provisional engineering target, not a measured benchmark.

**NFR-07 — Multi-application scalability.** The system must support multiple registered applications and concurrent deployments for different applications without changing the core requirements or deployment lifecycle. No numeric capacity target is established in this phase.

**NFR-08 — Authentication boundary.** The Deployment API must authenticate callers before allowing application or deployment operations. The authentication mechanism is an implementation decision.

**NFR-09 — Authorization boundary.** The platform must authorize callers for the applications and deployment operations they may access; one caller must not gain access to another caller's application configuration or deployment details without authorization. The identity model and policy mechanism are implementation decisions.

**NFR-10 — Secret handling.** Secrets and credentials used to access AWS, Kubernetes, or external systems must not be exposed in API responses, deployment events, or ordinary application logs. Their storage and delivery mechanism is an implementation decision.

**NFR-11 — AWS permissions.** The platform's AWS access must be limited to the permissions needed for its defined interactions with AWS services. The specific IAM roles and policies are implementation decisions.

**NFR-12 — Kubernetes permissions.** The controller's Kubernetes permissions must be limited to the resources and operations required for the defined deployment, observation, and reconciliation behavior. The specific RBAC rules are implementation decisions.

**NFR-13 — Container image security boundary.** A deployment must reference the requested image in AWS ECR. The platform must not claim an image is secure solely because it is deployable; image scanning is performed by the existing CI/security-scan flow. Any additional enforcement policy is a future implementation decision.

**NFR-14 — Sensitive configuration.** Sensitive application configuration must not be returned through application/deployment read APIs or written to ordinary logs/events. The secret/configuration storage mechanism is an implementation decision.

**NFR-15 — Diagnostic observability.** Logs, metrics, and deployment events must provide enough information to identify the deployment, lifecycle stage, health evaluation outcome, relevant Kubernetes observation, and failure/rollback reason without exposing secrets.

**NFR-16 — Persistent recoverability.** Deployment state and lifecycle events needed to recover non-terminal deployments must survive Deployment Controller restarts. Persistence must use the platform's designated persistent state store; retention periods and backup/recovery objectives are implementation decisions.

## 4. System Boundaries and Responsibilities

### Inside the Platform

- **Deployment API:** accepts application and deployment operations, returns application/deployment information, and exposes deployment status subject to authentication and authorization requirements.
- **Deployment Controller:** creates and observes Kubernetes resources, tracks desired state, advances deployment lifecycle, reconciles differences, and recovers non-terminal work.
- **Health Monitor:** evaluates configured canary signals and records results at each traffic stage.
- **Rollback Manager:** stops promotion on failure, restores traffic to the previous healthy version, and records rollback outcome and reason.
- **PostgreSQL:** designated persistent store for application configuration and deployment state/events required by the functional and recovery requirements.
- **Redis:** an in-platform component named by the problem definition. Its specific responsibility is not established by the requirements in this phase and remains an implementation decision.

### External Systems

- **GitHub:** source control for application code; it is outside the control plane.
- **GitHub Actions:** runs tests and security scans, builds container images, and pushes images to ECR; CI execution is outside the control plane.
- **AWS ECR:** stores container images referenced by deployment requests; image storage is outside the control plane.
- **AWS EKS:** provides the Kubernetes environment in which application workloads run; cluster infrastructure is outside the control plane.
- **Kubernetes API:** external interface through which the controller creates, observes, and reconciles workload resources and deployment traffic configuration.
- **Prometheus:** external metrics system from which health measurements may be obtained or to which platform metrics may be exposed; exact integration is an implementation decision.
- **Grafana:** external visualization system for metrics; dashboards are not required for MVP acceptance.
- **CloudWatch:** external AWS observability service; exact logs/metrics integration is an implementation decision.

## 5. MVP Requirements

The MVP must demonstrate the following minimum capabilities:

1. Register an application and store/retrieve its deployment configuration (FR-01 through FR-03).
2. Accept a deployment request for a specific image/version, persist it, track its status, and return deployment details (FR-04 through FR-08).
3. Prevent conflicting active deployments for the same application and make request retries idempotent (FR-09, FR-10, FR-34).
4. Deploy v1 as the initial healthy version, then deploy v2 alongside v1 (FR-11, FR-16).
5. Start v2 at the configured canary traffic percentage below 100%; support configured progressive stages and health evaluation between stages (FR-17 through FR-19).
6. Monitor v2 using HTTP error rate, latency, pod readiness, and pod restart failures; promote a healthy v2 through the stages to 100% traffic (FR-20, FR-22 through FR-24).
7. Detect a deliberately broken v2, stop promotion, restore v1 to 100% traffic and v2 to 0%, record the reason, and complete an idempotent rollback (FR-21, FR-25 through FR-30).
8. Recover persisted deployment progress after a controller restart, observe actual Kubernetes state, and continue/reconcile an interrupted deployment (FR-06, FR-15, FR-33; NFR-01, NFR-16).
9. Expose deployment state, versions, canary percentage, events/timestamps, health results, pod health, and rollback details (FR-35 through FR-37).

The documented success stages (10%, 25%, 50%, 100%) and failed-canary result (v2 at 0%, v1 at 100%) are acceptance examples from the problem definition. Health thresholds and evaluation windows remain configurable and must be set for an MVP demonstration; this requirements document does not prescribe their values.

## 6. Post-MVP Requirements

The following capabilities are not required to accept the initial MVP:

- Advanced autoscaling
- Richer dashboards beyond the status and diagnostic exposure required by FR-35 through FR-37
- Advanced security controls beyond the authentication, authorization, secret-handling, and permission boundaries in NFR-08 through NFR-14
- Additional deployment strategies beyond progressive canary deployment
- Chaos testing
- Advanced tracing

## 7. Acceptance Criteria / Definition of Done

The MVP is accepted only when the criteria below pass using real Kubernetes workloads, measurable health metrics, and automated rollback behavior.

### Application and Deployment Management (FR-01–FR-10)

- **Given** an authorized caller and an unregistered application, **when** the caller registers it with configuration, **then** the application and configuration are persisted and can be retrieved.
- **Given** a registered application, **when** a valid deployment request names an image/version and strategy, **then** one deployment is created, its request and state are persisted, and its details and status can be retrieved.
- **Given** an active deployment for an application, **when** a conflicting deployment is submitted for that same application, **then** the request does not start a second independent deployment and the caller receives a conflict/result indication.
- **Given** an accepted deployment request, **when** the same request is retried, **then** the existing deployment is identified and no duplicate independent deployment is created.

### Controller, State, and Recovery (FR-11–FR-15, FR-31–FR-34; NFR-01–NFR-03, NFR-16)

- **Given** a persisted deployment request, **when** the controller processes it, **then** it creates the required Kubernetes resources, observes their state, and records lifecycle progress.
- **Given** actual Kubernetes state that differs from desired state, **when** the controller reconciles, **then** it moves actual state toward desired state or records a failure that blocks unsafe promotion.
- **Given** a controller restart during a non-terminal deployment, **when** the controller resumes, **then** it loads persisted progress, observes Kubernetes state, and resumes/reconciles without losing state or skipping an unevaluated canary stage.
- **Given** a target pod crash, **when** the controller and health monitor observe it, **then** readiness/restart health is evaluated and traffic is not promoted while a required condition is failing.
- **Given** a deployment that cannot complete before canary or whose rollback cannot complete, **when** failure is determined, **then** it reaches `FAILED` with failure details recorded.

### Canary Health, Promotion, and Rollback (FR-16–FR-30)

- **Given** healthy v1 and a valid v2 deployment, **when** v2 enters canary, **then** v2 runs alongside v1 and initially receives the configured traffic percentage below 100%, with the remaining traffic on v1.
- **Given** a configured sequence of traffic stages, **when** a stage begins, **then** the platform evaluates configured HTTP error rate, latency, pod readiness, and restart-failure conditions before advancing.
- **Given** all required health conditions pass at a stage, **when** that stage's evaluation completes, **then** traffic advances to the next configured stage and that evaluation is recorded.
- **Given** all required evaluations pass through the final stage, **when** the target reaches 100% traffic, **then** the deployment state becomes `SUCCEEDED`.
- **Given** a deliberately broken v2 that fails a configured health condition, **when** the failure is detected, **then** the platform records `CANARY_FAILED`, halts promotion, and begins `ROLLING_BACK`.
- **Given** a canary in rollback, **when** rollback completes, **then** v2 receives 0% traffic, v1 receives 100%, the deployment reaches `ROLLED_BACK`, and the failed condition/reason and outcome are retrievable.
- **Given** duplicate rollback requests/events, **when** they are processed, **then** the rollback does not create duplicate independent actions and the final traffic state remains v1 at 100% and v2 at 0%.
- **Given** a required health measurement is missing, **when** a stage is evaluated, **then** it cannot be treated as healthy or promoted on the basis of that missing measurement.

### Observability (FR-35–FR-37; NFR-15)

- **Given** a deployment in any lifecycle state, **when** an authorized caller retrieves its details, **then** state, current/target versions, current canary percentage, available health results, and timestamps are exposed.
- **Given** a failed canary or rollback, **when** an operator inspects deployment details/events, **then** the failed condition, rollback reason, and rollback outcome can be identified without secret values appearing in the output.

### Security and Performance Boundaries (NFR-04–NFR-14)

- **Given** an unauthenticated caller, **when** it invokes a protected application or deployment operation, **then** the operation is denied.
- **Given** an authenticated caller without authorization for an application's data, **when** it requests that application's configuration or deployment details, **then** access is denied.
- **Given** secret values in configuration or credentials used by integrations, **when** APIs, logs, or events are produced, **then** those values are not exposed.
- **Given** the initial MVP load profile, **when** API acceptance/read operations and controller reactions are measured, **then** results are reported against the provisional NFR-05 and NFR-06 targets; these measurements establish observed performance and do not convert the initial targets into production SLOs.

## 8. Decisions Deferred to Implementation

The following are intentionally not fixed by this requirements specification: health threshold values and evaluation windows; request idempotency key format; authentication and authorization mechanisms; secret storage/delivery mechanism; exact AWS IAM and Kubernetes RBAC policies; Redis's specific role; Prometheus/Grafana/CloudWatch integration details; persistence retention and backup objectives; deployment capacity targets; and production performance/SLO commitments.
