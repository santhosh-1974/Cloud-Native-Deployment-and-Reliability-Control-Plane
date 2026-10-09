/**
 * Deployment service — atomic admission, idempotency, and retrieval.
 *
 * ## Atomic Admission Protocol
 *
 * Deployment creation runs inside a single serializable PostgreSQL transaction:
 *
 *   BEGIN
 *     -- 1. Lock the application row to serialize concurrent requests
 *     SELECT ... FROM applications WHERE id = $applicationId FOR UPDATE
 *
 *     -- 2. Check for duplicate request identity (idempotency)
 *     SELECT id FROM deployments WHERE request_identity = $requestIdentity FOR UPDATE
 *     → if found: ROLLBACK, return existing deployment
 *
 *     -- 3. Check active-deployment invariant
 *     SELECT count(*) FROM deployments
 *       WHERE application_id = $applicationId
 *         AND status NOT IN (SUCCEEDED, FAILED, ROLLED_BACK)
 *     → if > 0: ROLLBACK, throw ActiveDeploymentConflict
 *
 *     -- 4. Insert deployment (unique constraint on request_identity is
 *            the database-level backstop against races)
 *     INSERT INTO deployments (...)
 *
 *     -- 5. Append DEPLOYMENT_CREATED event
 *     INSERT INTO deployment_events (...)
 *   COMMIT
 *
 * The `SELECT ... FOR UPDATE` on the application row is the serialization
 * point: concurrent requests for the same application queue behind the lock
 * rather than racing a non-atomic check-then-insert.
 *
 * The unique constraint on `request_identity` is a database-level backstop:
 * even if two transactions somehow passed the active-deployment check
 * concurrently (e.g., different request identities), only one can commit an
 * identical request_identity INSERT.
 */
import { randomUUID } from 'node:crypto';
import { DeploymentEventType, DeploymentStatus, Prisma } from '@prisma/client';
import { prisma } from '../db/prisma-client.js';
import { Errors } from '../errors/domain-errors.js';
import { logger } from '../infrastructure/logger.js';
import type { CreateDeploymentInput } from '../api/validation.js';

// ---------------------------------------------------------------------------
// View / DTO types
// ---------------------------------------------------------------------------

export interface StageTrafficView {
  stageIndex: number;
  desiredCanaryPct: number;
  desiredStablePct: number;
  appliedCanaryPct: number | null;
  appliedStablePct: number | null;
  /** null means not yet verified — never present desired as observed */
  observedCanaryPct: number | null;
  observedStablePct: number | null;
  status: string;
}

export interface DeploymentView {
  id: string;
  applicationId: string;
  requestIdentity: string;
  targetImage: string;
  stableImage: string | null;
  desiredReplicas: number;
  port: number;
  strategy: Record<string, unknown>;
  status: DeploymentStatus;
  revision: number;
  currentStageIndex: number | null;
  currentStage: StageTrafficView | null;
  rollbackReason: string | null;
  rollbackOutcome: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface DeploymentStatusView {
  id: string;
  applicationId: string;
  status: DeploymentStatus;
  revision: number;
  targetImage: string;
  stableImage: string | null;
  currentStageIndex: number | null;
  /** Desired traffic percentage to the canary version (null when no stage active) */
  desiredCanaryPct: number | null;
  /** Observed/verified traffic percentage — null when not yet verified */
  observedCanaryPct: number | null;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Terminal statuses (deployment is no longer active)
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES: DeploymentStatus[] = [
  DeploymentStatus.SUCCEEDED,
  DeploymentStatus.FAILED,
  DeploymentStatus.ROLLED_BACK,
];

const MAX_ADMISSION_ATTEMPTS = 4;

function isRetryableTransactionConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

// ---------------------------------------------------------------------------
// Create deployment (atomic admission)
// ---------------------------------------------------------------------------

export async function createDeployment(
  applicationId: string,
  input: CreateDeploymentInput,
): Promise<DeploymentView> {
  // Generate a request identity if the caller did not supply one.
  const requestIdentity = input.requestIdentity ?? randomUUID();

  // Keep the full admission check and both writes in one serializable
  // transaction. PostgreSQL can abort a waiter with P2034 after it obtains
  // the application lock because its serializable snapshot is now stale.
  // Retry only that transient transaction error, rerunning every check.
  for (let attempt = 1; attempt <= MAX_ADMISSION_ATTEMPTS; attempt++) {
    try {
      const result = await prisma.$transaction(
        async (tx) => {
          // Step 1: Lock the application row to serialize admission for this app.
          const applicationRows = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM applications WHERE id = ${applicationId} FOR UPDATE
          `;
          if (applicationRows.length === 0) {
            throw Errors.applicationNotFound(applicationId);
          }

          // Step 2: Return an existing deployment for an idempotent retry.
          const existing = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM deployments
            WHERE request_identity = ${requestIdentity}
            FOR UPDATE
          `;
          if (existing.length > 0 && existing[0] !== undefined) {
            const found = await tx.deployment.findUniqueOrThrow({
              where: { id: existing[0].id },
              include: { stages: { orderBy: { stageIndex: 'asc' } } },
            });
            return { deployment: found, created: false };
          }

          // Step 3: Enforce the active-deployment invariant under the lock.
          const activeCount = await tx.deployment.count({
            where: {
              applicationId,
              status: { notIn: TERMINAL_STATUSES },
            },
          });
          if (activeCount > 0) {
            throw Errors.activeDeploymentConflict(applicationId);
          }

          // Step 4: Create the deployment.
          const newDeployment = await tx.deployment.create({
            data: {
              applicationId,
              requestIdentity,
              targetImage: input.image,
              stableImage: input.stableImage ?? null,
              desiredReplicas: input.replicas,
              port: input.port,
              strategy: input.strategy as unknown as Prisma.InputJsonValue,
              status: DeploymentStatus.PENDING,
              revision: 0,
            },
            include: { stages: true },
          });

          // Step 5: Append the event in the same transaction as the deployment.
          await tx.deploymentEvent.create({
            data: {
              deploymentId: newDeployment.id,
              eventType: DeploymentEventType.DEPLOYMENT_CREATED,
              payload: {
                requestIdentity,
                targetImage: input.image,
                desiredReplicas: input.replicas,
                port: input.port,
                strategy: input.strategy,
              } as unknown as Prisma.InputJsonValue,
            },
          });

          return { deployment: newDeployment, created: true };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 10_000,
        },
      );

      if (result.created) {
        logger.info('deployment_created', {
          deploymentId: result.deployment.id,
          applicationId,
          requestIdentity,
          targetImage: input.image,
        });
      } else {
        logger.info('deployment_idempotent_return', {
          requestIdentity,
          existingDeploymentId: result.deployment.id,
        });
      }

      return toDeploymentView(result.deployment);
    } catch (error) {
      if (!isRetryableTransactionConflict(error) || attempt === MAX_ADMISSION_ATTEMPTS) {
        throw error;
      }

      // Small bounded backoff gives the transaction that holds the row lock
      // time to commit. The next attempt rechecks both idempotency and active
      // deployment state under a fresh serializable snapshot.
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** (attempt - 1)));
    }
  }

  // The loop either returns a committed deployment or throws its last error.
  throw new Error('Deployment admission exhausted without a result');
}

// ---------------------------------------------------------------------------
// Retrieve deployment
// ---------------------------------------------------------------------------

export async function getDeployment(deploymentId: string): Promise<DeploymentView> {
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    include: { stages: { orderBy: { stageIndex: 'asc' } } },
  });
  if (!deployment) throw Errors.deploymentNotFound(deploymentId);
  return toDeploymentView(deployment);
}

// ---------------------------------------------------------------------------
// Retrieve deployment status (lightweight)
// ---------------------------------------------------------------------------

export async function getDeploymentStatus(deploymentId: string): Promise<DeploymentStatusView> {
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    include: { stages: { orderBy: { stageIndex: 'asc' } } },
  });
  if (!deployment) throw Errors.deploymentNotFound(deploymentId);

  // Find the current active stage for traffic information
  const currentStage =
    deployment.currentStageIndex !== null
      ? deployment.stages.find((s) => s.stageIndex === deployment.currentStageIndex) ?? null
      : null;

  return {
    id: deployment.id,
    applicationId: deployment.applicationId,
    status: deployment.status,
    revision: deployment.revision,
    targetImage: deployment.targetImage,
    stableImage: deployment.stableImage,
    currentStageIndex: deployment.currentStageIndex,
    desiredCanaryPct: currentStage?.desiredCanaryPct ?? null,
    observedCanaryPct: currentStage?.observedCanaryPct ?? null,
    updatedAt: deployment.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Internal mapper
// ---------------------------------------------------------------------------

type DeploymentWithStages = Awaited<ReturnType<typeof prisma.deployment.findUniqueOrThrow>> & {
  stages: Array<{
    stageIndex: number;
    desiredCanaryPct: number;
    desiredStablePct: number;
    appliedCanaryPct: number | null;
    appliedStablePct: number | null;
    observedCanaryPct: number | null;
    observedStablePct: number | null;
    status: string;
  }>;
};

function toDeploymentView(deployment: DeploymentWithStages): DeploymentView {
  const currentStage =
    deployment.currentStageIndex !== null
      ? deployment.stages.find((s) => s.stageIndex === deployment.currentStageIndex) ?? null
      : null;

  const currentStageView: StageTrafficView | null = currentStage
    ? {
        stageIndex: currentStage.stageIndex,
        desiredCanaryPct: currentStage.desiredCanaryPct,
        desiredStablePct: currentStage.desiredStablePct,
        appliedCanaryPct: currentStage.appliedCanaryPct,
        appliedStablePct: currentStage.appliedStablePct,
        observedCanaryPct: currentStage.observedCanaryPct,
        observedStablePct: currentStage.observedStablePct,
        status: currentStage.status,
      }
    : null;

  return {
    id: deployment.id,
    applicationId: deployment.applicationId,
    requestIdentity: deployment.requestIdentity,
    targetImage: deployment.targetImage,
    stableImage: deployment.stableImage,
    desiredReplicas: deployment.desiredReplicas,
    port: deployment.port,
    strategy: deployment.strategy as Record<string, unknown>,
    status: deployment.status,
    revision: deployment.revision,
    currentStageIndex: deployment.currentStageIndex,
    currentStage: currentStageView,
    rollbackReason: deployment.rollbackReason,
    rollbackOutcome: deployment.rollbackOutcome,
    createdAt: deployment.createdAt.toISOString(),
    updatedAt: deployment.updatedAt.toISOString(),
    completedAt: deployment.completedAt ? deployment.completedAt.toISOString() : null,
  };
}
