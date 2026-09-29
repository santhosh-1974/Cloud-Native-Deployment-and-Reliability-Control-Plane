# Architecture Review & Validation

## 1. Review Scope and Verdict Basis

Reviewed `PROBLEM_DEFINITION.md`, `REQUIREMENTS.md` (FR-01–FR-37 and NFR-01–NFR-16), and `ARCHITECTURE.md`. The review is read-only with respect to those documents. Status meanings: **PASS** means the architecture explicitly provides a coherent mechanism; **PARTIAL** means an owner/mechanism exists but a needed guarantee, contract, or failure behavior is unresolved; **FAIL** means the proposed architecture cannot meet the requirement as written.

The architecture is directionally viable but does not yet specify enough serialization, fencing, stage-operation persistence, outage policy, or traffic verification to guarantee safety under races and partial failures. Some security and performance needs are boundaries/targets rather than demonstrated properties. The final verdict is therefore **ARCHITECTURE REQUIRES CHANGES**.

## 2. Functional Requirements Traceability

| ID | Responsible component | Architectural mechanism | Status | Gap or ambiguity |
|---|---|---|---|---|
| FR-01 | Deployment API | Authenticated application registration persisted in PostgreSQL. | PASS | None material at architecture level. |
| FR-02 | Deployment API, PostgreSQL | Supplied application configuration stored durably. | PASS | Exact supported configuration fields are intentionally deferred. |
| FR-03 | Deployment API, PostgreSQL | Read application record by identifier. | PASS | None material at architecture level. |
| FR-04 | Deployment API | Accepts app, image, replicas, port, strategy/steps; validates and persists asynchronously. | PASS | Exact schema is deferred as allowed. |
| FR-05 | Deployment API, PostgreSQL | Persisted request carries target image reference/version. | PASS | Image immutability/digest policy is not defined, but not required by FR-05. |
| FR-06 | PostgreSQL | Durable deployment intent/lifecycle/stage/evaluation/event records. | PARTIAL | Entity concepts are named, but exact commit boundary and minimum recovery fields are not guaranteed; see persistence review. |
| FR-07 | Controller, PostgreSQL, API | Lifecycle transitions persisted and read by API. | PASS | Assumes serialized/validated transitions; concurrency enforcement is a gap. |
| FR-08 | API, PostgreSQL | Deployment record plus stage, health, rollback data returned. | PASS | Exact API representation deferred. |
| FR-09 | API, Controller, PostgreSQL, Redis | Active-deployment check plus per-app Redis lease. | PARTIAL | No atomic durable reservation/unique active deployment guarantee is specified; concurrent API requests can both pass a check. Redis lease alone can expire or be lost. |
| FR-10 | API, PostgreSQL | Request identity lookup returns existing deployment. | PARTIAL | Idempotency key/canonical request identity and atomic create-or-return transaction are deferred, so same request cannot yet be guaranteed to deduplicate. |
| FR-11 | Controller, Kubernetes API | Create/update Deployment, Service, and Ingress resources in EKS. | PASS | ALB controller dependency/configuration is noted. |
| FR-12 | Controller, PostgreSQL | Derive desired workload/traffic/lifecycle state from persisted request and stage. | PASS | Correctness depends on stage transition serialization not yet defined. |
| FR-13 | Controller, Kubernetes API | Observe Deployments, Pods, Services, Ingress and ALB-related status. | PASS | Exact source of authoritative applied ALB weight needs definition. |
| FR-14 | Controller | Compare desired and observed actual state; issue idempotent corrections or block promotion. | PARTIAL | Repeated failure/retry limit and terminal failure policy are deferred. The stated retry behavior has no bounded policy or operator-visible stuck-state rule. |
| FR-15 | Controller, PostgreSQL | Restart scans non-terminal rows, reloads state and re-observes EKS. | PARTIAL | Recovery fields and atomic intent/action/result protocol are conceptual only; restart between persistence and an external side effect is not fully disambiguated. |
| FR-16 | Controller, Kubernetes API | Stable and target version Deployments/Services coexist. | PASS | Previous version retention duration after success is open but coexistence during rollout is covered. |
| FR-17 | Controller, Ingress/ALB | Initial below-100% weight, remaining weight stable. | PASS | Depends on ALB integration, health of target group, and no competing writer. |
| FR-18 | Controller, ALB integration | Ordered request stages applied as complementary stable/target weights. | PASS | ALB weights are routing proportions, not an exact guarantee of observed request counts; architecture acknowledges this. |
| FR-19 | Controller, Health Monitor | Evaluate current applied stage over configured window before next stage. | PARTIAL | No explicit durable validation-start/window boundary or measurement freshness rule; controller restart may re-evaluate a partial window ambiguously. |
| FR-20 | Controller, Health Monitor, ALB | Promote only on health pass; final observed target 100% leads to `SUCCEEDED`. | PARTIAL | Architecture says final 100% observed after required passing evaluation, but detailed state graph also permits `PROMOTING → SUCCEEDED` on final weight; ordering and whether final 100% itself is health-gated need one unambiguous rule. |
| FR-21 | Health Monitor, Controller | Failed evaluation stops stage advancement and dispatches rollback. | PARTIAL | Promotion/rollback serialization is not specified; a concurrent stale PASS can race a failure and write a later stage. |
| FR-22 | Health Monitor | Prometheus for error/latency; Kubernetes API for readiness/restarts. | PARTIAL | Metric instrumentation/query contract and restart-failure measurement semantics are assumptions, not established architecture inputs. |
| FR-23 | Health Monitor, Controller | Configured required conditions; missing data indeterminate and cannot pass. | PARTIAL | Missing-data timeout/outcome is deferred; this prevents false PASS but leaves validation potentially non-terminal forever. |
| FR-24 | Health Monitor, PostgreSQL | Result persisted with deployment and stage identity. | PASS | No material gap if those identifiers are committed atomically with result. |
| FR-25 | Health Monitor, Controller, PostgreSQL | Persist failed condition and `CANARY_FAILED`. | PASS | Depends on FR-21 race serialization. |
| FR-26 | Controller | Failed state disallows promotion and requests rollback. | PARTIAL | No durable fencing/cancellation of already in-flight promotion writes; state-machine rule alone does not prevent a delayed stale operation. |
| FR-27 | Rollback Manager, Ingress/ALB | Desired final weights stable 100%, target 0%, observed before completion. | PARTIAL | Mechanism is viable, but the architecture does not define how to verify data-plane propagation rather than only Kubernetes desired Ingress state; ALB eventual update/health behavior remains an assumption. |
| FR-28 | Controller, PostgreSQL, API | Persist and expose failure reason and rollback result. | PASS | None material at conceptual level. |
| FR-29 | Controller, Rollback Manager | `ROLLED_BACK` only after restored weights are verified. | PARTIAL | Verification source/freshness and proof that traffic is no longer reaching target are unspecified. |
| FR-30 | Rollback Manager, Controller | Reapply identical rollback desired weights idempotently. | PARTIAL | Idempotent desired values are described, but fencing against concurrent promotion and atomic transition ownership are missing. |
| FR-31 | Controller, PostgreSQL | Named state set, graph, entry/actions/exits and invalid transitions documented. | PARTIAL | Graph is mostly coherent but final-stage health order is ambiguous (FR-20), and transition enforcement under concurrent workers is not defined. |
| FR-32 | Controller, Health Monitor | Observe pod readiness/restarts; no promotion on failing required condition; reconcile or fail. | PARTIAL | When Kubernetes self-heals a crashing pod versus when restart failures constitute unhealthy is not operationally defined; could remain validating indefinitely. |
| FR-33 | Controller, PostgreSQL, Kubernetes API | Reload stage/evaluations, observe weight and workload, resume reconciliation. | PARTIAL | Completed/current/unevaluated are conceptually mentioned, but no durable in-flight operation/epoch or stage evaluation window marker distinguishes all crash points robustly. |
| FR-34 | Deployment API, PostgreSQL | Retry maps to existing request. | PARTIAL | Same unresolved identity and atomicity gap as FR-10. |
| FR-35 | API, PostgreSQL, Controller | Expose state, versions, current canary percentage. | PARTIAL | Percentage may reflect persisted desired value rather than verified data-plane actual value; API should distinguish desired/applied/observed traffic. |
| FR-36 | Controller, PostgreSQL | Timestamp lifecycle and traffic events. | PASS | Adequate at architecture level. |
| FR-37 | Health Monitor, Controller, PostgreSQL, API | Persist/expose metric observations, pod state, rollback detail. | PASS | Exact metric labels/query and retention deferred. |

## 3. Non-Functional Requirements Traceability

| ID | Responsible component | Architectural mechanism | Status | Gap or ambiguity |
|---|---|---|---|---|
| NFR-01 | PostgreSQL, Controller | Persist non-terminal work; restart scan and reconcile. | PARTIAL | Requires atomic operation/stage records and database durability; transaction/write ordering is unspecified. |
| NFR-02 | API, Controller, Rollback Manager | Request identity, idempotent resource writes and rollback desired state. | PARTIAL | No atomic deduplication, worker fencing, or stale action prevention. |
| NFR-03 | Controller, PostgreSQL, Kubernetes API | Reobserve actual state and persist reconciled state or failure. | PARTIAL | Repeated reconciliation failure handling is unspecified; no bounded retries or stale-state reporting contract. |
| NFR-04 | Deployment API/platform | API/controller are separate modules/process roles from application workloads. | PASS | Requirement only guarantees application pod failures do not by themselves take down control-plane access, assuming platform dependencies remain available. |
| NFR-05 | API | Initial 500 ms p95 read/acceptance target. | PARTIAL | Architecture makes request execution asynchronous but offers no load profile, measurement plan, or resource isolation to show the initial target is achievable. |
| NFR-06 | Controller | Initial 30 s p95 reaction target excluding health windows/external outage. | PARTIAL | Polling cadence, worker capacity, and load profile are not specified; target is not shown feasible. |
| NFR-07 | API, Controller, PostgreSQL, Redis | Per-app coordination and concurrent work for different applications; modular monolith. | PARTIAL | No capacity/concurrency plan or bottleneck limit; Redis locks alone do not establish scalable safe parallelism. |
| NFR-08 | Deployment API | Authentication boundary stated for all application/deployment operations. | PARTIAL | No identity source, token/session validation, or unauthenticated denial flow component/mechanism selected. |
| NFR-09 | Deployment API | Per-application authorization stated. | PARTIAL | No ownership/tenant mapping or policy evaluation mechanism; registration ownership is especially undefined. |
| NFR-10 | Platform, logging | Secret values excluded from responses/events/logs. | PARTIAL | Handling/redaction boundary is a requirement, but no source, storage, injection, or redaction enforcement mechanism is defined. |
| NFR-11 | AWS IAM | Least-needed AWS access asserted. | PARTIAL | No concrete trust boundary or distinction between CI push identity and runtime EKS/ALB controller identity. |
| NFR-12 | Kubernetes RBAC | Narrow namespace-scoped controller permissions asserted. | PARTIAL | Exact managed resource scope and ALB integration permissions are not mapped; namespace-per-app is itself undecided. |
| NFR-13 | GitHub Actions, ECR, API | CI scans image; deployment refers to ECR image; platform does not claim security solely from deployability. | PASS | This matches the requirement boundary; no additional enforcement is required. |
| NFR-14 | Deployment API, PostgreSQL, logging | Sensitive configuration omitted from reads/logs/events. | PARTIAL | No way to distinguish secret from ordinary config or enforce field-level redaction is described. |
| NFR-15 | Platform, Prometheus, CloudWatch, PostgreSQL | Logs/metrics/events identify deployment, phase, health, K8s observation, failure without secrets. | PARTIAL | Required identifiers/data are listed, but correlation format, K8s observation capture, and log/metric export path are not defined. |
| NFR-16 | PostgreSQL | Durable store retains non-terminal state/events across controller restart. | PARTIAL | Controller-restart durability is plausible, but DB restart/failure, backup, and durable commit guarantees are not addressed. |

## 4. Critical Flow Validation

### 4.1 Successful Deployment

| Transition | Actor and action | Durable state expected | Crash behavior / review |
|---|---|---|---|
| Developer → GitHub | Developer commits source. | Outside platform; GitHub revision/CI event. | Platform is not yet involved; CI can be rerun independently. |
| GitHub → GitHub Actions | GitHub triggers tests/security scan/build. | CI result outside platform. | Not part of controller recovery. |
| GitHub Actions → ECR | CI pushes built image. | Image is stored in ECR; platform later stores the requested image reference. | If push succeeds but caller does not submit deployment, no platform deployment exists. |
| ECR → Deployment API | Caller submits request referencing image (image pull itself later occurs from EKS). | API persists request as `PENDING`, identity, app, target image, request configuration. | If API crashes before commit, request is not accepted; after commit, retry should resolve existing record, but FR-10 atomic idempotency is a gap. |
| API → PostgreSQL | API validates and commits deployment. | Application association, request identity, target/version, lifecycle. | API must not return accepted before durable commit; architecture implies this but does not state commit/response boundary explicitly. |
| PostgreSQL → Controller | Worker discovers non-terminal record. | `PENDING`, later `DEPLOYING`, stage/work intent and events. | Restart scan is specified; duplicate worker exclusion and durable claim/fencing are not guaranteed. |
| Controller → Kubernetes | Create target Deployment/Service; EKS pulls image from ECR; wait for readiness. | Desired resource/version intent and observed readiness/event. | Crash between write and record can be reconciled if deterministic resource identity and desired intent are durable; those identifiers/write ordering need clarification. |
| Kubernetes → Canary | Controller applies initial Ingress/ALB weight, stable remains live. | Current desired stage/weight, applied/observed weight and stage state. | Crash during ALB propagation needs intent + observed data-plane state. Architecture checks Kubernetes/Ingress status but does not establish when ALB data plane is actually effective. |
| Canary → Health Monitor | Controller requests evaluation for deployment/stage. | Evaluation window identity/start/end and stage association should be persisted. | Architecture persists evaluation result, but window boundaries/freshness are not explicit. |
| Health Monitor → Promotion | Monitor returns PASS; controller advances to next configured stage. | PASS result then next-stage intent/event. | Delayed PASS can arrive after failure/rollback; no stage epoch/fencing is described. Unsafe stale transition is possible. |
| Promotion → 100% → `SUCCEEDED` | Controller applies final weight, observes it, marks terminal. | Final stage, passing evaluation, observed 100%, success event/state. | Final stage should also be evaluated per requirements; architecture's graph/text disagree on whether final PASS precedes success. Must clarify. |

**Finding:** The high-level flow is plausible, but not fully crash-safe at external side-effect boundaries. Required corrections RC-01, RC-02, and RC-04 address atomic request identity, operation/stage checkpointing, and verification of applied traffic.

### 4.2 Failed Deployment

Expected sequence: persisted deployment → target alongside stable → canary stage applied → Health Monitor records failing signal → controller commits `CANARY_FAILED` and failure reason → `ROLLING_BACK` intent → Rollback Manager requests stable 100% / target 0% → observed routing verification → `ROLLED_BACK`.

The architecture correctly says failure reason is persisted before/with rollback dispatch, promotion must stop on failure, rollback is idempotent in desired values, and rollback failure ends in `FAILED`. It does **not** define a durable serialization/fencing mechanism that invalidates an already-running promotion or delayed PASS result. Thus “no unsafe promotion after health failure” is not guaranteed under concurrent/stale work yet. Kubernetes Ingress status may also represent controller reconciliation rather than confirmed ALB data-plane propagation. Corrections RC-02 and RC-04 are required.

### 4.3 Controller Crash and Stage Distinction

The architecture can distinguish some cases conceptually:

- **Completed stage:** stage and health result are described as persisted.
- **Unevaluated stage:** no passing evaluation is present, so controller should remain/return to validation.
- **Currently executing stage:** only partly represented by lifecycle state and intended/observed weight. No explicit operation attempt/phase, stage epoch, or evaluation window checkpoint is required.

For a crash after an external weight write but before durable completion, the controller can inspect actual state and reapply the same desired value. That is useful reconciliation, but the specification does not define atomic checkpoint ordering, authoritative applied-state source, or stale-worker fencing. A restarted controller can therefore race a still-running worker or accept an old evaluation. Corrections RC-02 and RC-03 are required.

## 5. Idempotency Review

| Case | Expected behavior | Architecture support | Finding |
|---|---|---|---|
| Duplicate deployment request | One logical record/execution; return existing result. | PostgreSQL lookup and active check are proposed. | **PARTIAL:** key/canonical identity and atomic create-or-return are deferred. Two concurrent requests may both create before either sees the other's active row. RC-01. |
| Duplicate promotion event | Do not advance twice. | Reapply desired traffic state and persisted stage are proposed. | **PARTIAL:** no conditional stage transition/version, unique stage operation, or stale event rejection. Duplicate applying same weight is safe, but duplicate increment/advance logic may skip a stage. RC-02/03. |
| Duplicate rollback event | No conflict; stable 100%, target 0%. | Rollback reapplies same final weights. | **PARTIAL:** desired value is idempotent but concurrent promotion can overwrite it; rollback needs exclusive/fenced ownership and verification. RC-02/03/04. |
| Controller restart mid-operation | Observe actual state before deciding/repeating. | Explicit restart scan and re-observation. | **PARTIAL:** insufficient operation checkpoint and fencing to distinguish stale/current workers and external write completion across all crash windows. RC-02/03. |

## 6. Desired vs Actual State Review

- **Desired state source:** accepted deployment request, persisted lifecycle phase, ordered traffic stages, previous healthy version, completed health evaluations. PostgreSQL is designated durable source.
- **Actual state source:** Kubernetes API observations of Deployment/Pods/Services/Ingress plus ALB-related state. The architecture does not precisely identify which field/API is authoritative for effective data-plane weights.
- **Difference detection:** controller compares target version, replicas/readiness, resources, and traffic configuration to desired state.
- **Reconciliation:** issue idempotent corrective writes, re-observe, persist events/state, then gate progress on health.
- **Repeated reconciliation failure:** architecture says retry and eventually `FAILED` if recovery cannot complete, but leaves classification, attempt/time bounds, backoff, and how to avoid declaring a transient outage permanently failed unresolved.

**Finding:** The conceptual distinction is clear; the state contract and failure policy are partial. Corrections RC-02, RC-04, and RC-05.

## 7. Canary Traffic Review

AWS ALB weighted target groups are technically capable of expressing the desired configured ratios (90:10, 75:25, 50:50, 0:100) while stable and target Services run concurrently, and the same mechanism can request rollback weights (100:0). No service mesh is needed. This is a viable MVP choice **subject to assumptions**:

1. AWS Load Balancer Controller and ALB weighted forwarding configuration are deployed and have narrowly scoped permissions.
2. Each version maps to a distinct Service/target group and stable target remains available through rollout/rollback.
3. No other actor writes the same Ingress/ALB weights.
4. Target group stickiness or other routing behavior does not undermine canary sampling; this needs explicit configuration/validation.
5. Configured weights are routing proportions, not exact realized request percentages. Low traffic volume can yield noisy observed shares.
6. Kubernetes Ingress status alone may not prove ALB data-plane propagation; health/rollback must verify the appropriate controller/ALB state and allow propagation before declaring success.
7. Weight 0 excludes target from new weighted forwarding, but in-flight requests may complete; rollback's “v2 = 0%” should mean effective new routing, not forcibly terminated requests.

The selected mechanism is not a FAIL, but the **traffic verification and no-competing-writer contract are PARTIAL**. Correction RC-04 specifies the minimum addition.

## 8. Health Evaluation Review

| Signal | Proposed source | Assessment |
|---|---|---|
| HTTP error rate | Prometheus time-series workload metrics. | PARTIAL: instrumentation, labels that isolate target version, query semantics, and freshness are assumed. Without version-scoped data, stable traffic can contaminate canary result. |
| Latency | Prometheus time-series workload metrics. | PARTIAL: same version attribution/query/freshness gap. |
| Pod readiness | Kubernetes Pod/Deployment status. | PASS at conceptual level; version/deployment association should use managed resource identity. |
| Pod restart failures | Kubernetes Pod restart status. | PARTIAL: restart count/window and failure condition are unspecified. |

Missing metrics are explicitly indeterminate and cannot pass. Evaluation results are intended to persist with deployment and stage, and controller owns the transition. However, a durable window/attempt identifier and stale-result rejection are missing. A missing metric may leave `VALIDATING` forever because timeout/outcome is deferred. Correction RC-05.

## 9. Persistence Review

The architecture names the necessary conceptual data: application; target image/version; previous healthy version; lifecycle state; ordered stages; health evaluation result; rollback reason/outcome; deployment events. This is a strong entity inventory, but recovery is not guaranteed merely by naming entities.

Missing or underspecified durable information/protocol:

- Stable request idempotency identity and atomic duplicate resolution.
- Distinct stage index plus desired weight, applied/observed weight, stage status (unevaluated/applying/applied/validating/passed/failed), and operation attempt/version.
- Health evaluation window boundaries, signal source/version scope, freshness, and evaluation attempt/result identity.
- External operation intent/ack checkpoints for resource/ALB changes, sufficient to decide after crash whether to observe, retry, or proceed.
- Monotonic deployment revision/fencing token so stale worker or delayed result cannot update newer state.
- Atomic conditional transition rules preventing two actors from advancing or rolling back concurrently.
- Durable rollback attempt and verification source/state before terminal transition.

This is not a request for final database schema. Correction RC-02 requires the architecture to name these logical recovery facts and ordering; exact columns remain for database design.

## 10. Redis Review

Redis is explicitly **not** authoritative state, which is correct. The architecture assigns temporary per-application coordination leases; it does not assign a work queue or store short-lived deployment payloads. The controller can discover work by polling PostgreSQL.

Redis is **not strictly required for the MVP** if a single controller worker is run, or if PostgreSQL provides the durable conditional claim/serialization mechanism. The requirements do not demand Redis or multiple controller replicas. Introducing Redis as a lock service adds a dependency without an MVP need and does not itself prevent stale workers after lease expiry unless fencing is defined.

Correction RC-06: either remove Redis from MVP runtime and use a single worker/durable PostgreSQL coordination, or retain Redis only if the architecture defines fail-closed behavior, lease renewal/expiry, and fencing that makes expired owners unable to commit side effects. Do not introduce a work queue; it is unnecessary for the stated MVP.

## 11. Failure Matrix

| Failure | Detection | State | Recovery/action | Safe expected final state |
|---|---|---|---|---|
| Target pod crash | Kubernetes API readiness/restart observation. | `VALIDATING` or `CANARY_FAILED`; pre-canary unrecoverable issue may be `FAILED`. | Kubernetes self-healing plus controller re-observation; no promotion while required signal fails. | Resume only on health pass; otherwise previous version restored and `ROLLED_BACK`. Restart failure criteria remain partial (RC-05). |
| Controller crash | Process restart; PostgreSQL non-terminal scan. | Persisted non-terminal state. | Reload, acquire coordination, observe actual state, reconcile. | Resume safely if durable operation checkpoint/fencing exists; currently partial (RC-02/03). |
| Kubernetes API unavailable | Failed read/write. | Preserve current non-terminal state. | Retry/reconcile; do not promote or claim rollback success. | Resume on recovery or `FAILED` by defined bounded policy; policy missing (RC-05). |
| Health metrics unavailable | Prometheus query missing/stale. | `VALIDATING`. | Mark indeterminate, block promotion, retry. | Pass only after fresh required signals pass; otherwise eventual configured failure/rollback. Timeout not specified (RC-05). |
| Canary failure | Health Monitor configured condition fails. | `CANARY_FAILED` → `ROLLING_BACK`. | Fence promotion, persist reason, apply stable 100/target 0, verify. | `ROLLED_BACK`, or `FAILED` if rollback cannot be completed. Concurrent stale action risk (RC-02/03). |
| Rollback failure | Weight/resource change not applied or verified. | `ROLLING_BACK`, then `FAILED` when determined unable to complete. | Retry/reconcile and preserve reason/outcome. | Never claim `ROLLED_BACK` without verification. Failure cutoff/verification source missing (RC-04/05). |
| Duplicate deployment | API request identity/active deployment check. | Existing record unchanged. | Return existing deployment; no new worker work. | One logical deployment. Atomic dedupe gap (RC-01). |
| Duplicate rollback | Repeated rollback dispatch/event. | `ROLLING_BACK`. | Reapply final desired weights under rollback ownership. | Previous 100%, target 0%; promotion must remain fenced. (RC-02/03). |
| Partial promotion | Crash after intent/write before completion. | `PROMOTING` with last durable stage. | Observe applied state; retry same operation or continue to validation. | Never skip unpassed stage; operation checkpoint gap (RC-02/04). |
| Database unavailable | API/controller persistence or read fails. | No new acceptance; existing operation cannot safely make lifecycle progress. | Fail closed: no unpersisted transition/promotion; after DB returns reload and observe cluster. | Traffic remains at last applied stage until state can be reconciled; architecture should explicitly specify this. Correction RC-05. |
| Redis unavailable | Lease acquire/renew fails. | Existing state remains non-terminal. | Current design lacks explicit behavior; safest is no new side effect without coordination, then resume after Redis returns. | Safe but rollout stalls; alternatively remove Redis for MVP (RC-06). |

## 12. Race Condition Review

| Race | Why it can happen | Current protection | Status / required protection |
|---|---|---|---|
| Two deployments for same app | Concurrent API calls both check no active deployment before either commits. | Per-app Redis lock is described for controller, not API admission; PostgreSQL active check is not stated atomic. | **Gap:** durable atomic reservation/unique active record and create-or-return transaction (RC-01). |
| Two workers process same deployment | Duplicate polling, worker restart, lease expiry while old worker is delayed. | Redis lease and reload are proposed. | **Gap:** fencing token/conditional state revision required; lease alone cannot stop expired worker (RC-03). |
| Promotion and rollback simultaneously | Delayed PASS/worker write races a health failure/rollback. | State machine says no promotion after failure. | **Gap:** state graph does not enforce external-write ownership; atomic compare-and-transition plus fencing and cancel/recheck immediately before weight writes (RC-02/03). |
| Health evaluation completes while rollback starts | Health query started earlier returns PASS after failure/rollback was initiated by another observation. | Controller owns lifecycle; results stored by stage. | **Gap:** result must be tied to stage revision/window and accepted only if deployment remains in matching `VALIDATING` revision (RC-02/03/05). |
| Restart during traffic change | ALB update may succeed while process crashes before PostgreSQL checkpoint. | Re-observe actual Kubernetes/ALB and reconcile. | **Partial:** direction is sound; effective data-plane observation and operation checkpoint are missing (RC-02/04). |
| Redis lease expires during slow Kubernetes call | TTL/renewal not specified; second worker may acquire while first still writes. | Lease proposed. | **Gap:** fencing at durable state and/or single-writer controller; lease alone insufficient (RC-03). |
| API read during traffic change | Persisted desired weight and actual routing can temporarily differ. | API exposes current canary percentage. | **Gap:** label desired vs applied/observed; do not present stale desired percentage as actual (RC-04). |

## 13. Security Review

| Boundary | Review | Status |
|---|---|---|
| API authentication | Requirement says every operation is authenticated; architecture places boundary at API but selects no identity validation mechanism. | PARTIAL |
| API authorization | Per-application authorization is stated, but ownership mapping and authorization for registration are undefined. | PARTIAL |
| AWS IAM | Least-needed permission goal is stated. Runtime platform, CI push identity, EKS integration, and ALB controller identities are not separated in the architecture. | PARTIAL |
| Kubernetes RBAC | Namespace-scoped minimal access is intended; namespace model and exact operations are undecided. No cluster-admin is assumed. | PARTIAL |
| Secret handling | No API/log exposure is required, but secret classification, storage, injection, and redaction enforcement are not described. | PARTIAL |
| ECR access | CI push and workload pull are identified; identity boundaries and private image pull authorization are not described. | PARTIAL |
| PostgreSQL access | Only platform components should access it; auth/network/isolation and data-level ownership checks are deferred. | PARTIAL |
| Redis access | Coordination-only and restricted access stated, but auth/network/lease fencing are unresolved. | PARTIAL |

No explicit broad permission is prescribed, but “least privilege” is an intent rather than a reviewable permission boundary. The architecture needs an identity/permission ownership map (not concrete credentials or policy files yet). Correction RC-07. The exact credential implementation can remain deferred.

## 14. Architecture Weaknesses

1. **Under-specified concurrency control:** a Redis lease is not a fencing mechanism. A worker whose lease expired can still complete a delayed Kubernetes write.
2. **Non-atomic request admission:** checking for an active deployment and then inserting is racy unless a durable atomic rule exists.
3. **Ambiguous desired-vs-applied traffic:** architecture can expose configured weights as if they were current actual traffic; ALB configuration propagation is asynchronous.
4. **Incomplete crash checkpoints:** request, stage, health window, and external side effect boundaries are not described as a recoverable protocol.
5. **Health data assumptions:** Prometheus queries need version-isolated metrics and freshness semantics; shared app metrics could mix stable and target signals.
6. **Indefinite validation possibility:** missing metrics have no timeout/outcome, leaving a deployment stuck in `VALIDATING` indefinitely.
7. **Final stage ordering ambiguity:** state graph can mark success after final 100% is observed while prose implies a passing health evaluation at that stage first.
8. **Rollback verification ambiguity:** Kubernetes desired Ingress may not prove ALB is routing stable-only; no explicit data-plane verification or propagation rule.
9. **Redis adds MVP dependency without necessity:** a single controller or PostgreSQL coordination could meet the initial need; Redis failure policy is absent.
10. **Single points of failure:** PostgreSQL, Redis (if required), the modular monolith, Kubernetes API/EKS, Prometheus, and ALB are dependencies. No high availability is specified; this is acceptable for an MVP only if failure-safe behavior is explicit.
11. **Security remains aspirational:** boundaries exist but identity and permission owners are not mapped sufficiently for least privilege review.
12. **Performance targets are unvalidated:** p95 response/controller targets have no defined initial load profile or measurement method.
13. **Some details are correctly deferred:** exact schemas, probes, resource values, threshold values, credentials, and infrastructure files should remain for later steps; review does not require designing them here.

## 15. Required Corrections

These are architecture/document corrections only; no implementation or requirements change is made in this review.

| Correction | Problem and why it matters | Smallest correction | Document to change |
|---|---|---|---|
| RC-01 — Atomic request identity/admission | FR-09/10 can race; two requests can create separate logical deployments. | Specify one durable atomic create-or-return/idempotency decision and atomic active-deployment reservation per application. Keep key format/schema for database design. | `ARCHITECTURE.md`; clarify guarantees in `REQUIREMENTS.md` only if current idempotency wording is insufficient. |
| RC-02 — Durable operation/stage protocol | Crash between DB commit and Kubernetes/ALB write leaves unclear in-flight status; duplicate events can skip stages. | Define logical stage fields/states (intent, applying, observed, validating, passed/failed) and order: persist intent → side effect → observe → persist acknowledgment; evaluation result tied to a stage revision. No SQL needed. | `ARCHITECTURE.md` |
| RC-03 — Worker fencing/transition serialization | Redis lease expiry and stale workers/results permit promotion after rollback starts. | Require conditional lifecycle transition on expected state/revision and monotonic fencing/revision checked before every external traffic mutation; stale worker/result is rejected. If PostgreSQL single-writer is selected, state that explicitly. | `ARCHITECTURE.md` |
| RC-04 — Traffic truth and final-stage rule | Desired Ingress weight may not equal effective ALB routing; success/rollback could be declared too early; API percent ambiguous. | Distinguish desired, controller-applied, and observed traffic. Name authoritative observation/verification condition; wait for it before evaluation/success/rollback completion. Specify final 100% health gate ordering and expose whether percentage is desired or observed. | `ARCHITECTURE.md` |
| RC-05 — Bounded dependency/metric failure behavior | API, DB, K8s, Prometheus outages can stall forever or leave semantics unclear. | Define fail-closed behavior (no promotion on unavailable state/data), retry classification, and configurable timeout/escalation to recorded failure/rollback where applicable; do not invent production thresholds. | `ARCHITECTURE.md`; `REQUIREMENTS.md` if missing-data termination must become normative. |
| RC-06 — Redis MVP justification/failure | Redis is not required by current MVP requirements and lease without fencing adds risk/dependency. | Prefer remove Redis from MVP and serialize via one worker or durable PostgreSQL coordination; alternatively retain only with explicit outage and fencing behavior. Do not use it as a queue. | `ARCHITECTURE.md`; `REQUIREMENTS.md` only if Redis must remain a required component. |
| RC-07 — Security ownership map | Least privilege/authentication claims cannot be checked with only abstract boundaries. | Identify separate caller, CI push, workload pull, platform AWS/EKS, ALB integration, database, and Redis identities and state owner/scope of each; keep actual credential values/policy files deferred. | `ARCHITECTURE.md` |
| RC-08 — Health source contract | Metrics may mix v1/v2 or be stale; pod restart condition lacks semantics. | Specify that metric queries are deployment/version scoped and fresh for the persisted evaluation window; identify Pod observations by target workload; defer names and threshold values. | `ARCHITECTURE.md` |
| RC-09 — Capacity target validation | NFR-05/06 targets cannot be assessed without load profile and measurement boundary. | State an initial MVP load profile and what start/end timestamps define each p95 target, or explicitly defer target validation while preserving them as provisional. | `ARCHITECTURE.md` and, if changing targets, `REQUIREMENTS.md` |

## 16. Final Verdict

The architecture has a viable high-level component split, a suitable canary traffic mechanism, appropriate durable-state intent, and a coherent reconciliation direction. It does not yet guarantee atomic idempotency, safe concurrent promotion/rollback, complete crash recovery at traffic side-effect boundaries, bounded outage handling, or verified traffic-state semantics. Multiple requirements therefore remain **PARTIAL**.

`ARCHITECTURE REQUIRES CHANGES`
## 17. Superseding Re-review (RC-01 through RC-09)

This section supersedes the earlier status findings. Evidence is in corrected Architecture Section 24. Requirements are unchanged.

### RC results

- RC-01 PASS: atomic PostgreSQL identity lookup/create and per-app reservation; concurrent duplicate returns one deployment.
- RC-02 PASS: durable stage substates; persist intent, act, observe, acknowledge; observe before retry on restart.
- RC-03 PASS: single DB-owned coordinator, monotonic revision, expected-state checks, ownership and Kubernetes resourceVersion checks before writes; stale results rejected.
- RC-04 PASS: desired/applied/observed traffic distinguished; ALB generation gates evaluation and rollback; final 100%, verify, health PASS, then SUCCEEDED.
- RC-05 PASS: configurable retry/exhaustion, fail-closed dependencies, no stale/missing PASS, no indefinite VALIDATING.
- RC-06 PASS: Redis removed from MVP; PostgreSQL serializes; no queue.
- RC-07 PASS: caller, CI, workload, platform, ALB and DB identities separated.
- RC-08 PASS: deployment/version/stage/revision/window-specific metrics; v1/v2 distinguishable; freshness and restart window defined.
- RC-09 PASS: baseline profile and API/controller timestamps defined; p95 targets provisional, not claimed achieved.

### Updated FR/NFR traceability

All IDs below are PASS; evidence applies to every listed ID.

| IDs | Evidence |
|---|---|
| FR-01, FR-02, FR-03 | API registration, durable config and retrieval. |
| FR-04, FR-05, FR-06, FR-07, FR-08 | Request/image persistence, lifecycle tracking and details. |
| FR-09, FR-10, FR-34 | Atomic active reservation and identity lookup/create-or-return. |
| FR-11, FR-12, FR-13, FR-14, FR-15 | Resource control, desired/actual reconcile, bounded failures and recovery. |
| FR-16, FR-17, FR-18, FR-19 | Coexisting versions, weighted stages, verified health windows. |
| FR-20, FR-21 | Each stage gated; final gate ordered; failure fences promotion. |
| FR-22, FR-23, FR-24 | Required sources, freshness/missing rules, scoped persisted evaluation. |
| FR-25, FR-26, FR-27, FR-28, FR-29, FR-30 | Failure reason, fenced halt, verified/idempotent rollback. |
| FR-31, FR-32, FR-33 | Legal terminal states, pod recovery, durable stage protocol. |
| FR-35, FR-36, FR-37 | Desired/observed status, events, health/rollback detail. |
| NFR-01, NFR-02, NFR-03 | Durable recovery, idempotency, reconciliation. |
| NFR-04, NFR-07 | Workload isolation and bounded work across different apps. |
| NFR-05, NFR-06 | Provisional p95 fixture, timestamps, exclusions. |
| NFR-08, NFR-09 | API auth and app-owner authorization. |
| NFR-10, NFR-14 | Sensitive fields excluded/redacted. |
| NFR-11, NFR-12, NFR-13 | Separate scoped CI/workload/controller/ALB identities. |
| NFR-15, NFR-16 | Correlated diagnostics and durable PostgreSQL recovery state. |

### Flow and safety re-check

Success: CI publishes image; API atomically commits PENDING; controller records intent, creates target, applies and observes ALB weights, persists fresh PASS at each stage. At final stage: request 100%, verify, evaluate final window, PASS, then SUCCEEDED.

Failure: health failure and reason commit CANARY_FAILED at a new revision; stale promotion is rejected; rollback intent precedes weight mutation; ALB verifies stable 100% / target 0%; only then ROLLED_BACK. Exhausted/unverified rollback is FAILED.

Desired traffic is durable PostgreSQL intent; applied traffic is reconciled Ingress generation; verified traffic is ALB/controller observation. Ingress spec alone is insufficient. API reports desired and observed separately. Health sources distinguish v1/v2 and bind results to deployment/version/stage/revision/window. Missing/stale data cannot pass. PostgreSQL keeps app, versions, state/revision, stage/substate, operation, weights, health window/result, rollback and events for recovery.

### Crash, race and failure re-check

Crash 1 (intent only): replacement observes, then acts/acknowledges. Crash 2 (ALB changed, no DB ack): observe generation, acknowledge match or retry same revision. Crash 3 (evaluation active): accept complete fresh result or restart attempt. Crash 4 (PASS before promotion): conditionally continue if durable/current, else reevaluate. Crash 5 (rollback): reload, observe/reapply/verify, then ROLLED_BACK or FAILED.

Races: same-app requests use atomic reservation; duplicate workers are serialized; rollback revision rejects promotion; delayed PASS is stale; ALB crash recovery observes first; Redis expiry is N/A; actual/desired divergence reconciles or fails closed.

Failure cases rechecked: Pod crash blocks promotion; controller crash recovers DB state; Kubernetes/Prometheus/ALB outage retries without unsafe progress; missing health is indeterminate; canary failure rolls back; rollback failure is FAILED; duplicate create/rollback is idempotent; partial promotion observes before retry; DB outage stops uncommitted writes; Redis outage is N/A.

### Security and performance re-check

Caller, GitHub Actions, EKS workload, platform controller, AWS Load Balancer Controller and PostgreSQL have distinct access boundaries. CI has no EKS access; workload has no control-plane DB access by default. Sensitive fields are excluded/redacted. Exact credentials and IAM/RBAC policies remain deferred implementation details.

The 500 ms API p95 and 30 s controller reaction p95 are provisional. Section 24 defines measurement profile, timestamps, external exclusions and reporting; it does not claim achievement. No architecture-level requirement remains uncovered. Schema, metric names, thresholds, policy values, credentials/policies and measured capacity are implementation/configuration decisions; requirements are unchanged.

## 18. Final Verdict

All RCs pass; all FR/NFR IDs are mapped to architecture mechanisms; success, failure, rollback, crash recovery, idempotency, reconciliation, health, persistence, races and security are coherent.

ARCHITECTURE APPROVED
