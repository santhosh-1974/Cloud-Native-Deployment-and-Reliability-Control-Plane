# Cloud-Native Deployment & Reliability Control Plane

## Project Name

**Cloud-Native Deployment & Reliability Control Plane**

## Problem Statement

A conventional deployment can replace a healthy production version with a new version immediately. If the new version has a defect, users may experience HTTP 5xx errors, increased latency, crashed containers, failed health checks, or service downtime.

The control plane addresses this risk by gradually exposing a new version to traffic and checking its health before increasing exposure. If the canary is unhealthy, the platform automatically restores traffic to the previous healthy version.

## Project Objective

Build a deployment and reliability control plane that safely deploys containerized applications to Kubernetes/AWS EKS using progressive canary deployments.

The system must accept deployment requests, persist deployment state, deploy and verify the new version, progressively shift traffic while monitoring health, automatically promote healthy deployments, automatically roll back unhealthy deployments, recover and reconcile state after controller crashes, and expose deployment status, health metrics, and rollback reasons.

## Core Deployment Flow

1. A developer changes application code in GitHub.
2. GitHub Actions runs tests and security scans, builds the container image, and pushes it to AWS ECR.
3. A deployment request is submitted to the Deployment API.
4. The Deployment Controller persists and processes the request, integrating with the Kubernetes API to deploy the new version to AWS EKS.
5. The platform verifies that the new version's pods are healthy and ready.
6. The platform routes an initial portion of traffic to the canary and monitors its health.
7. If the canary satisfies health conditions, the platform advances traffic through the configured steps and ultimately promotes the new version.
8. If the canary violates health or SLO thresholds, the platform rolls back traffic to the previous healthy version and records the rollback reason.
9. If the controller crashes, it recovers persisted deployment state and reconciles actual Kubernetes state with the desired deployment state.

Example request:

```json
{
  "application": "payments-api",
  "image": "123456789.dkr.ecr.ap-south-1.amazonaws.com/payments:v42",
  "replicas": 3,
  "port": 3000,
  "strategy": {
    "type": "canary",
    "steps": [10, 25, 50, 100]
  }
}
```

## System Boundaries

The platform's primary responsibility is safe and reliable application deployment. It coordinates deployment state, Kubernetes changes, progressive traffic shifting, health evaluation, promotion, rollback, recovery, and deployment observability.

External systems provide source control and CI (GitHub and GitHub Actions), image storage (AWS ECR), container orchestration (Kubernetes/AWS EKS), and infrastructure management (Terraform).

## Core Components

- Deployment API
- Deployment Controller
- PostgreSQL for persisted deployment state
- Redis
- Health Monitor
- Rollback Manager
- Kubernetes API integration
- Observability system

External infrastructure and services:

- GitHub
- GitHub Actions
- AWS ECR
- AWS EKS
- AWS infrastructure managed using Terraform

## Required Guarantees

### Progressive Deployment

A new version must not immediately receive 100% of traffic.

### Health-Based Promotion

A canary must satisfy configured health conditions before traffic is increased.

### Automatic Rollback

If a canary violates health or SLO thresholds, the platform must automatically restore traffic to the previous healthy version.

### Idempotency

Retrying the same deployment request must not create duplicate independent deployments.

### Controller Recovery

If the Deployment Controller crashes during a deployment, it must recover persisted state and reconcile actual Kubernetes state with the desired deployment state.

### Observability

The system must expose:

- Deployment state
- Current version
- Target version
- Canary traffic percentage
- Error rate
- Latency
- Pod health
- Deployment events
- Rollback reason

## Deployment Success Scenario

Initial condition: v1 is the current production version.

1. Deploy v2.
2. Route 10% of traffic to v2 and retain 90% on v1.
3. When v2 passes health checks, advance v2 through 25%, then 50%, then 100% of traffic, validating health at each step.
4. Mark the deployment `SUCCESS` when v2 receives 100% of traffic after passing the health checks.

## Deployment Failure and Rollback Scenario

Initial condition: v1 is the current production version.

1. Deploy v3.
2. Route 10% of traffic to v3 and retain 90% on v1.
3. If v3 produces excessive errors and the error rate exceeds the configured threshold, mark the deployment `CANARY_FAILED`.
4. Automatically roll back: route 0% of traffic to v3 and restore 100% of traffic to v1.
5. Record rollback success and the reason for rollback.

## Scope

This project is a deployment and reliability control plane for safe, progressive application releases to Kubernetes/AWS EKS. It is not a full Heroku clone. The platform owns deployment orchestration and reliability behavior while relying on the external systems identified above for CI, image storage, container orchestration, and infrastructure management.

## Out of Scope

The project will not build:

- A general-purpose PaaS
- A replacement for Kubernetes
- A replacement for GitHub Actions
- A container registry
- A service mesh
- A multi-cloud platform
- Unnecessary microservices

## Definition of Done

The core project is successful when it demonstrates both scenarios using real Kubernetes workloads, measurable health metrics, and actual automated rollback logic:

- **Successful deployment:** v1 starts as the current production version; v2 begins at 10% traffic while v1 retains 90%; v2 passes health checks at each stage; traffic advances through 25%, 50%, and 100%; the deployment reaches `SUCCESS`.
- **Failed deployment:** v1 starts as the current production version; v3 begins at 10% traffic while v1 retains 90%; v3 exceeds the configured error-rate threshold; the deployment reaches `CANARY_FAILED`; automated rollback sets v3 to 0% and restores v1 to 100%; rollback succeeds.
