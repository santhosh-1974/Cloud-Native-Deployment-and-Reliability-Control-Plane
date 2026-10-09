import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { PrismaClient, DeploymentStatus, StageStatus, EvaluationResult, DeploymentEventType } from '@prisma/client';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const prisma = new PrismaClient();
const testAppPrefix = `database-test-${randomUUID()}`;

function uid(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

after(async () => {
  const belongsToThisRun = { deployment: { application: { name: { startsWith: testAppPrefix } } } };
  await prisma.deploymentEvent.deleteMany({ where: belongsToThisRun });
  await prisma.healthEvaluation.deleteMany({ where: belongsToThisRun });
  await prisma.deploymentStage.deleteMany({ where: { deployment: { application: { name: { startsWith: testAppPrefix } } } } });
  await prisma.deployment.deleteMany({ where: { application: { name: { startsWith: testAppPrefix } } } });
  await prisma.application.deleteMany({ where: { name: { startsWith: testAppPrefix } } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

async function createApp(name?: string) {
  return prisma.application.create({
    data: {
      name: `${testAppPrefix}-${name ?? uid()}`,
      config: { defaultReplicas: 2, defaultPort: 3000 },
    },
  });
}

async function createDeployment(applicationId: string, overrides?: Record<string, unknown>) {
  return prisma.deployment.create({
    data: {
      applicationId,
      requestIdentity: uid(),
      targetImage: '123.dkr.ecr.region.amazonaws.com/app:v2',
      stableImage: '123.dkr.ecr.region.amazonaws.com/app:v1',
      desiredReplicas: 3,
      port: 3000,
      strategy: { type: 'canary', steps: [10, 25, 50, 100] },
      status: DeploymentStatus.PENDING,
      revision: 0,
      ...overrides,
    },
  });
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

void describe('Application uniqueness', () => {
  void it('creates an application with a unique name', async () => {
    const app = await createApp('payments-api-' + uid());
    assert.ok(app.id);
    assert.ok(app.name);
    assert.ok(app.createdAt);
    assert.ok(app.updatedAt);
  });

  void it('rejects duplicate application names', async () => {
    const name = 'dup-app-' + uid();
    await createApp(name);
    await assert.rejects(
      () => createApp(name),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        // Prisma wraps the unique constraint error
        assert.ok(err.message.includes('Unique constraint'));
        return true;
      },
    );
  });
});

void describe('Deployment request idempotency', () => {
  void it('creates a deployment with a unique request identity', async () => {
    const app = await createApp();
    const dep = await createDeployment(app.id);
    assert.ok(dep.id);
    assert.equal(dep.status, DeploymentStatus.PENDING);
    assert.equal(dep.revision, 0);
  });

  void it('rejects duplicate request identities', async () => {
    const app = await createApp();
    const requestIdentity = uid();
    await prisma.deployment.create({
      data: {
        applicationId: app.id,
        requestIdentity,
        targetImage: 'app:v1',
        desiredReplicas: 2,
        port: 3000,
        strategy: { type: 'canary', steps: [10, 100] },
      },
    });
    await assert.rejects(
      () =>
        prisma.deployment.create({
          data: {
            applicationId: app.id,
            requestIdentity, // same identity
            targetImage: 'app:v2',
            desiredReplicas: 2,
            port: 3000,
            strategy: { type: 'canary', steps: [10, 100] },
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('Unique constraint'));
        return true;
      },
    );
  });
});

void describe('Active deployment protection', () => {
  void it('allows sequential deployments for the same application', async () => {
    const app = await createApp();

    // First deployment: terminal
    const d1 = await createDeployment(app.id, { status: DeploymentStatus.SUCCEEDED });
    assert.equal(d1.status, DeploymentStatus.SUCCEEDED);

    // Second deployment: pending — allowed because first is terminal
    const d2 = await createDeployment(app.id, { status: DeploymentStatus.PENDING });
    assert.equal(d2.status, DeploymentStatus.PENDING);
    assert.notEqual(d1.id, d2.id);
  });

  void it('can query non-terminal deployments for an application', async () => {
    const app = await createApp();
    await createDeployment(app.id, { status: DeploymentStatus.PENDING });
    await createDeployment(app.id, { status: DeploymentStatus.SUCCEEDED }); // terminal

    const nonTerminal = await prisma.deployment.findMany({
      where: {
        applicationId: app.id,
        status: {
          notIn: [
            DeploymentStatus.SUCCEEDED,
            DeploymentStatus.FAILED,
            DeploymentStatus.ROLLED_BACK,
          ],
        },
      },
    });
    // We should find exactly 1 non-terminal deployment
    assert.equal(nonTerminal.length, 1);
    assert.equal(nonTerminal[0]?.status, DeploymentStatus.PENDING);
  });
});

void describe('Stage ordering', () => {
  void it('creates ordered stages for a deployment', async () => {
    const app = await createApp();
    const dep = await createDeployment(app.id);

    // Create 4 stages: 10%, 25%, 50%, 100%
    const stages = [
      { stageIndex: 0, desiredCanaryPct: 10, desiredStablePct: 90 },
      { stageIndex: 1, desiredCanaryPct: 25, desiredStablePct: 75 },
      { stageIndex: 2, desiredCanaryPct: 50, desiredStablePct: 50 },
      { stageIndex: 3, desiredCanaryPct: 100, desiredStablePct: 0 },
    ];

    for (const s of stages) {
      await prisma.deploymentStage.create({
        data: {
          deploymentId: dep.id,
          ...s,
          status: StageStatus.UNEVALUATED,
          applyAttempt: 0,
        },
      });
    }

    const fetched = await prisma.deploymentStage.findMany({
      where: { deploymentId: dep.id },
      orderBy: { stageIndex: 'asc' },
    });

    assert.equal(fetched.length, 4);
    assert.equal(fetched[0]?.stageIndex, 0);
    assert.equal(fetched[0]?.desiredCanaryPct, 10);
    assert.equal(fetched[3]?.stageIndex, 3);
    assert.equal(fetched[3]?.desiredCanaryPct, 100);
  });

  void it('rejects duplicate stage indices within a deployment', async () => {
    const app = await createApp();
    const dep = await createDeployment(app.id);

    await prisma.deploymentStage.create({
      data: {
        deploymentId: dep.id,
        stageIndex: 0,
        desiredCanaryPct: 10,
        desiredStablePct: 90,
        status: StageStatus.UNEVALUATED,
        applyAttempt: 0,
      },
    });

    await assert.rejects(
      () =>
        prisma.deploymentStage.create({
          data: {
            deploymentId: dep.id,
            stageIndex: 0, // duplicate
            desiredCanaryPct: 25,
            desiredStablePct: 75,
            status: StageStatus.UNEVALUATED,
            applyAttempt: 0,
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('Unique constraint'));
        return true;
      },
    );
  });
});

void describe('Revision / fencing', () => {
  void it('starts at revision 0 and supports conditional updates', async () => {
    const app = await createApp();
    const dep = await createDeployment(app.id);
    assert.equal(dep.revision, 0);

    // Simulate a conditional update (WHERE revision = 0)
    const updated = await prisma.deployment.updateMany({
      where: { id: dep.id, revision: 0 },
      data: { status: DeploymentStatus.DEPLOYING, revision: 1 },
    });
    assert.equal(updated.count, 1);

    const reloaded = await prisma.deployment.findUniqueOrThrow({ where: { id: dep.id } });
    assert.equal(reloaded.revision, 1);
    assert.equal(reloaded.status, DeploymentStatus.DEPLOYING);
  });

  void it('a stale revision update affects 0 rows (fencing)', async () => {
    const app = await createApp();
    const dep = await createDeployment(app.id);

    // Advance revision to 1
    await prisma.deployment.update({
      where: { id: dep.id },
      data: { revision: 1 },
    });

    // Stale worker tries to update with old revision 0
    const staleUpdate = await prisma.deployment.updateMany({
      where: { id: dep.id, revision: 0 }, // stale revision
      data: { status: DeploymentStatus.DEPLOYING, revision: 1 },
    });

    assert.equal(staleUpdate.count, 0, 'stale worker must not update any rows');
  });
});

void describe('Health evaluation', () => {
  void it('creates a health evaluation linked to deployment, stage, and revision', async () => {
    const app = await createApp();
    const dep = await createDeployment(app.id);
    const stage = await prisma.deploymentStage.create({
      data: {
        deploymentId: dep.id,
        stageIndex: 0,
        desiredCanaryPct: 10,
        desiredStablePct: 90,
        status: StageStatus.VALIDATING,
        applyAttempt: 1,
        validationStartedAt: new Date(),
      },
    });

    const evaluation = await prisma.healthEvaluation.create({
      data: {
        deploymentId: dep.id,
        stageId: stage.id,
        deploymentRevision: dep.revision,
        windowStart: new Date(Date.now() - 60_000),
        windowEnd: new Date(),
        result: EvaluationResult.PASS,
        isFresh: true,
        observations: { errorRate: 0.001, latencyP99Ms: 120, readyPods: 3, restartCount: 0 },
      },
    });

    assert.ok(evaluation.id);
    assert.equal(evaluation.deploymentId, dep.id);
    assert.equal(evaluation.stageId, stage.id);
    assert.equal(evaluation.deploymentRevision, 0);
    assert.equal(evaluation.result, EvaluationResult.PASS);
    assert.equal(evaluation.isFresh, true);
  });

  void it('stores FAIL evaluations with a failure reason', async () => {
    const app = await createApp();
    const dep = await createDeployment(app.id);
    const stage = await prisma.deploymentStage.create({
      data: {
        deploymentId: dep.id,
        stageIndex: 0,
        desiredCanaryPct: 10,
        desiredStablePct: 90,
        status: StageStatus.VALIDATING,
        applyAttempt: 1,
        validationStartedAt: new Date(),
      },
    });

    const evaluation = await prisma.healthEvaluation.create({
      data: {
        deploymentId: dep.id,
        stageId: stage.id,
        deploymentRevision: dep.revision,
        windowStart: new Date(Date.now() - 60_000),
        windowEnd: new Date(),
        result: EvaluationResult.FAIL,
        isFresh: true,
        failureReason: 'error rate 0.12 exceeds threshold 0.05',
        observations: { errorRate: 0.12, latencyP99Ms: 340, readyPods: 3, restartCount: 0 },
      },
    });

    assert.equal(evaluation.result, EvaluationResult.FAIL);
    assert.equal(evaluation.failureReason, 'error rate 0.12 exceeds threshold 0.05');
  });
});

void describe('Deployment events', () => {
  void it('appends events with correct deployment association', async () => {
    const app = await createApp();
    const dep = await createDeployment(app.id);

    await prisma.deploymentEvent.create({
      data: {
        deploymentId: dep.id,
        eventType: DeploymentEventType.DEPLOYMENT_CREATED,
        payload: { requestIdentity: dep.requestIdentity },
      },
    });

    await prisma.deploymentEvent.create({
      data: {
        deploymentId: dep.id,
        eventType: DeploymentEventType.DEPLOYMENT_STARTED,
        payload: { revision: dep.revision },
      },
    });

    const events = await prisma.deploymentEvent.findMany({
      where: { deploymentId: dep.id },
      orderBy: { occurredAt: 'asc' },
    });

    assert.equal(events.length, 2);
    assert.equal(events[0]?.eventType, DeploymentEventType.DEPLOYMENT_CREATED);
    assert.equal(events[1]?.eventType, DeploymentEventType.DEPLOYMENT_STARTED);
    assert.equal(events[0]?.deploymentId, dep.id);
  });

  void it('supports all defined event types without error', async () => {
    const app = await createApp();
    const dep = await createDeployment(app.id);

    const eventTypes: DeploymentEventType[] = [
      DeploymentEventType.DEPLOYMENT_CREATED,
      DeploymentEventType.STAGE_INTENT_RECORDED,
      DeploymentEventType.TRAFFIC_APPLY_STARTED,
      DeploymentEventType.TRAFFIC_APPLIED,
      DeploymentEventType.TRAFFIC_VERIFIED,
      DeploymentEventType.HEALTH_VALIDATION_STARTED,
      DeploymentEventType.HEALTH_VALIDATION_PASSED,
      DeploymentEventType.ROLLBACK_STARTED,
      DeploymentEventType.ROLLBACK_VERIFIED,
      DeploymentEventType.DEPLOYMENT_ROLLED_BACK,
    ];

    for (const eventType of eventTypes) {
      await prisma.deploymentEvent.create({
        data: { deploymentId: dep.id, eventType, payload: {} },
      });
    }

    const count = await prisma.deploymentEvent.count({ where: { deploymentId: dep.id } });
    assert.equal(count, eventTypes.length);
  });
});
