/**
 * Integration tests for the Deployment API — Phase 1, Step 3.
 *
 * These tests run against the real Docker Compose PostgreSQL database and
 * exercise the full HTTP→service→database stack.  Each test suite cleans its
 * own data in `before`/`after` hooks.
 *
 * Run with:
 *   DATABASE_URL=<url> npm test
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, describe, it } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { PrismaClient, DeploymentStatus } from '@prisma/client';

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let app: Express;
const prisma = new PrismaClient();
const testAppPrefix = `api-test-${randomUUID()}`;

// Helper: unique-ish identifier for test isolation
function uid(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function appName(label: string): string {
  return `${testAppPrefix}-${label}-${uid()}`;
}

async function cleanTestData(): Promise<void> {
  const belongsToThisRun = { deployment: { application: { name: { startsWith: testAppPrefix } } } };
  await prisma.deploymentEvent.deleteMany({ where: belongsToThisRun });
  await prisma.healthEvaluation.deleteMany({ where: belongsToThisRun });
  await prisma.deploymentStage.deleteMany({ where: { deployment: { application: { name: { startsWith: testAppPrefix } } } } });
  await prisma.deployment.deleteMany({ where: { application: { name: { startsWith: testAppPrefix } } } });
  await prisma.application.deleteMany({ where: { name: { startsWith: testAppPrefix } } });
}

before(async () => {
  process.env['NODE_ENV'] = 'test';
  ({ app } = await import('../src/app'));
});

after(async () => {
  await cleanTestData();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

async function createTestApp(name?: string): Promise<{ body: { application: { id: string; name: string } } }> {
  const res = await request(app)
    .post('/applications')
    .send({ name: name ?? appName('app') });
  assert.equal(res.status, 201);
  return res as unknown as { body: { application: { id: string; name: string } } };
}

function validDeploymentBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    image: '123456789.dkr.ecr.ap-south-1.amazonaws.com/payments:v42',
    replicas: 3,
    port: 3000,
    strategy: { type: 'canary', steps: [10, 25, 50, 100] },
    ...overrides,
  };
}

// ===========================================================================
// Application tests
// ===========================================================================

void describe('POST /applications', () => {
  void it('creates an application and returns 201', async () => {
    const name = appName('payments-api');
    const res = await request(app).post('/applications').send({ name });
    assert.equal(res.status, 201);
    assert.ok(res.body.application.id, 'should have an id');
    assert.equal(res.body.application.name, name);
    assert.ok(res.body.application.createdAt);
    assert.ok(res.body.application.updatedAt);
  });

  void it('stores optional config', async () => {
    const res = await request(app)
      .post('/applications')
      .send({ name: appName('cfg-app'), config: { defaultReplicas: 2 } });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.application.config, { defaultReplicas: 2 });
  });

  void it('rejects a duplicate application name with 409', async () => {
    const name = appName('dup');
    await request(app).post('/applications').send({ name }).expect(201);
    const res = await request(app).post('/applications').send({ name });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'DUPLICATE_APPLICATION_NAME');
  });

  void it('rejects missing name with 400', async () => {
    const res = await request(app).post('/applications').send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  void it('rejects empty name with 400', async () => {
    const res = await request(app).post('/applications').send({ name: '' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  void it('rejects name with invalid characters', async () => {
    const res = await request(app).post('/applications').send({ name: 'my app!' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  void it('rejects non-object config', async () => {
    const res = await request(app)
      .post('/applications')
      .send({ name: appName('nc'), config: 'not-an-object' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });
});

void describe('GET /applications/:applicationId', () => {
  void it('returns an existing application', async () => {
    const created = await createTestApp();
    const id = created.body.application.id;
    const res = await request(app).get(`/applications/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.application.id, id);
    assert.equal(res.body.application.name, created.body.application.name);
  });

  void it('returns 404 for unknown application', async () => {
    const res = await request(app).get('/applications/00000000-0000-0000-0000-000000000000');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'APPLICATION_NOT_FOUND');
  });
});

// ===========================================================================
// Deployment creation tests
// ===========================================================================

void describe('POST /applications/:applicationId/deployments', () => {
  void it('creates a deployment and returns 201', async () => {
    const { body: { application } } = await createTestApp();
    const res = await request(app)
      .post(`/applications/${application.id}/deployments`)
      .send(validDeploymentBody());

    assert.equal(res.status, 201);
    const dep = res.body.deployment;
    assert.ok(dep.id, 'should have deployment id');
    assert.equal(dep.applicationId, application.id);
    assert.equal(dep.status, DeploymentStatus.PENDING);
    assert.equal(dep.revision, 0);
    assert.ok(dep.requestIdentity, 'should have a request identity');
    assert.equal(dep.targetImage, '123456789.dkr.ecr.ap-south-1.amazonaws.com/payments:v42');
    assert.equal(dep.desiredReplicas, 3);
    assert.equal(dep.port, 3000);
    assert.deepEqual(dep.strategy, { type: 'canary', steps: [10, 25, 50, 100] });
    assert.ok(dep.createdAt);
    assert.ok(dep.updatedAt);
    assert.equal(dep.completedAt, null);
    assert.equal(dep.rollbackReason, null);
    assert.equal(dep.rollbackOutcome, null);
    assert.equal(dep.currentStageIndex, null);
    assert.equal(dep.currentStage, null);
  });

  void it('deployment begins as PENDING', async () => {
    const { body: { application } } = await createTestApp();
    const res = await request(app)
      .post(`/applications/${application.id}/deployments`)
      .send(validDeploymentBody());
    assert.equal(res.body.deployment.status, 'PENDING');
  });

  void it('deployment has initial revision 0', async () => {
    const { body: { application } } = await createTestApp();
    const res = await request(app)
      .post(`/applications/${application.id}/deployments`)
      .send(validDeploymentBody());
    assert.equal(res.body.deployment.revision, 0);
  });

  void it('persists a DEPLOYMENT_CREATED event', async () => {
    const { body: { application } } = await createTestApp();
    const res = await request(app)
      .post(`/applications/${application.id}/deployments`)
      .send(validDeploymentBody());
    assert.equal(res.status, 201);
    const deploymentId: string = res.body.deployment.id;

    const events = await prisma.deploymentEvent.findMany({
      where: { deploymentId, eventType: 'DEPLOYMENT_CREATED' },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.eventType, 'DEPLOYMENT_CREATED');
  });

  void it('returns 404 when application does not exist', async () => {
    const res = await request(app)
      .post('/applications/00000000-0000-0000-0000-000000000000/deployments')
      .send(validDeploymentBody());
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'APPLICATION_NOT_FOUND');
  });

  // -------------------------------------------------------------------------
  // Validation tests
  // -------------------------------------------------------------------------

  void it('rejects missing image with 400', async () => {
    const { body: { application } } = await createTestApp();
    const res = await request(app)
      .post(`/applications/${application.id}/deployments`)
      .send(validDeploymentBody({ image: undefined }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  void it('rejects empty image with 400', async () => {
    const { body: { application } } = await createTestApp();
    const res = await request(app)
      .post(`/applications/${application.id}/deployments`)
      .send(validDeploymentBody({ image: '' }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  void it('rejects replicas = 0 with 400', async () => {
    const { body: { application } } = await createTestApp();
    const res = await request(app)
      .post(`/applications/${application.id}/deployments`)
      .send(validDeploymentBody({ replicas: 0 }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  void it('rejects replicas > 100 with 400', async () => {
    const { body: { application } } = await createTestApp();
    const res = await request(app)
      .post(`/applications/${application.id}/deployments`)
      .send(validDeploymentBody({ replicas: 101 }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  void it('rejects port 0 with 400', async () => {
    const { body: { application } } = await createTestApp();
    const res = await request(app)
      .post(`/applications/${application.id}/deployments`)
      .send(validDeploymentBody({ port: 0 }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  void it('rejects port > 65535 with 400', async () => {
    const { body: { application } } = await createTestApp();
    const res = await request(app)
      .post(`/applications/${application.id}/deployments`)
      .send(validDeploymentBody({ port: 70000 }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  void it('rejects missing strategy with 400', async () => {
    const { body: { application } } = await createTestApp();
    const res = await request(app)
      .post(`/applications/${application.id}/deployments`)
      .send(validDeploymentBody({ strategy: undefined }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  void it('rejects unknown strategy type with 400', async () => {
    const { body: { application } } = await createTestApp();
    const res = await request(app)
      .post(`/applications/${application.id}/deployments`)
      .send(validDeploymentBody({ strategy: { type: 'rolling', steps: [100] } }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  void it('rejects empty strategy steps with 400', async () => {
    const { body: { application } } = await createTestApp();
    const res = await request(app)
      .post(`/applications/${application.id}/deployments`)
      .send(validDeploymentBody({ strategy: { type: 'canary', steps: [] } }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  void it('rejects strategy not ending with 100 with 400', async () => {
    const { body: { application } } = await createTestApp();
    const res = await request(app)
      .post(`/applications/${application.id}/deployments`)
      .send(validDeploymentBody({ strategy: { type: 'canary', steps: [10, 50] } }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  void it('rejects strategy step > 100 with 400', async () => {
    const { body: { application } } = await createTestApp();
    const res = await request(app)
      .post(`/applications/${application.id}/deployments`)
      .send(validDeploymentBody({ strategy: { type: 'canary', steps: [10, 150] } }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  void it('rejects empty requestIdentity with 400', async () => {
    const { body: { application } } = await createTestApp();
    const res = await request(app)
      .post(`/applications/${application.id}/deployments`)
      .send(validDeploymentBody({ requestIdentity: '' }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  // -------------------------------------------------------------------------
  // Idempotency tests
  // -------------------------------------------------------------------------

  void it('returns the same deployment for the same requestIdentity (idempotency)', async () => {
    const { body: { application } } = await createTestApp();
    const requestIdentity = `idem-${uid()}`;

    const res1 = await request(app)
      .post(`/applications/${application.id}/deployments`)
      .send(validDeploymentBody({ requestIdentity }));
    assert.equal(res1.status, 201);
    const id1: string = res1.body.deployment.id;

    const res2 = await request(app)
      .post(`/applications/${application.id}/deployments`)
      .send(validDeploymentBody({ requestIdentity }));
    // Second call returns the EXISTING deployment (idempotent)
    assert.ok(res2.status === 200 || res2.status === 201);
    const id2: string = res2.body.deployment.id;
    assert.equal(id1, id2, 'both requests must resolve to the same deployment');
  });

  void it('two calls without requestIdentity create two different deployments for different apps', async () => {
    const app1Res = await createTestApp();
    const app2Res = await createTestApp();

    const r1 = await request(app)
      .post(`/applications/${app1Res.body.application.id}/deployments`)
      .send(validDeploymentBody());
    const r2 = await request(app)
      .post(`/applications/${app2Res.body.application.id}/deployments`)
      .send(validDeploymentBody());

    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);
    assert.notEqual(r1.body.deployment.id, r2.body.deployment.id);
  });

  // -------------------------------------------------------------------------
  // Active deployment protection tests
  // -------------------------------------------------------------------------

  void it('rejects a second deployment for an application with an active deployment (409)', async () => {
    const { body: { application } } = await createTestApp();

    // First deployment
    const r1 = await request(app)
      .post(`/applications/${application.id}/deployments`)
      .send(validDeploymentBody());
    assert.equal(r1.status, 201);

    // Second deployment with a DIFFERENT requestIdentity → must be rejected
    const r2 = await request(app)
      .post(`/applications/${application.id}/deployments`)
      .send(validDeploymentBody({ requestIdentity: `new-${uid()}` }));
    assert.equal(r2.status, 409);
    assert.equal(r2.body.error.code, 'ACTIVE_DEPLOYMENT_CONFLICT');
  });

  void it('allows a new deployment after the previous is terminal (SUCCEEDED)', async () => {
    const { body: { application } } = await createTestApp();

    // Create and manually mark as SUCCEEDED
    const r1 = await request(app)
      .post(`/applications/${application.id}/deployments`)
      .send(validDeploymentBody());
    assert.equal(r1.status, 201);
    await prisma.deployment.update({
      where: { id: r1.body.deployment.id },
      data: { status: DeploymentStatus.SUCCEEDED, completedAt: new Date() },
    });

    // New deployment should succeed
    const r2 = await request(app)
      .post(`/applications/${application.id}/deployments`)
      .send(validDeploymentBody({ requestIdentity: `new-${uid()}` }));
    assert.equal(r2.status, 201);
    assert.notEqual(r1.body.deployment.id, r2.body.deployment.id);
  });

  void it('concurrent requests for the same application: exactly one succeeds', async () => {
    const { body: { application } } = await createTestApp();

    // Fire two concurrent requests simultaneously
    const [r1, r2] = await Promise.all([
      request(app)
        .post(`/applications/${application.id}/deployments`)
        .send(validDeploymentBody({ requestIdentity: `concurrent-a-${uid()}` })),
      request(app)
        .post(`/applications/${application.id}/deployments`)
        .send(validDeploymentBody({ requestIdentity: `concurrent-b-${uid()}` })),
    ]);

    const statuses = [r1.status, r2.status].sort();
    // One must be 201 (created) and the other 409 (conflict)
    assert.deepEqual(statuses, [201, 409]);

    // Verify only one active deployment row exists
    const active = await prisma.deployment.count({
      where: {
        applicationId: application.id,
        status: { notIn: [DeploymentStatus.SUCCEEDED, DeploymentStatus.FAILED, DeploymentStatus.ROLLED_BACK] },
      },
    });
    assert.equal(active, 1);
  });

  void it('concurrent identical requestIdentity: both resolve to the same deployment', async () => {
    const { body: { application } } = await createTestApp();
    const requestIdentity = `same-${uid()}`;

    const [r1, r2] = await Promise.all([
      request(app)
        .post(`/applications/${application.id}/deployments`)
        .send(validDeploymentBody({ requestIdentity })),
      request(app)
        .post(`/applications/${application.id}/deployments`)
        .send(validDeploymentBody({ requestIdentity })),
    ]);

    // Both must succeed (one creates, one returns existing)
    assert.ok(r1.status === 200 || r1.status === 201, `r1 status: ${r1.status}`);
    assert.ok(r2.status === 200 || r2.status === 201, `r2 status: ${r2.status}`);
    assert.equal(r1.body.deployment.id, r2.body.deployment.id, 'both must resolve to same deployment');
  });
});

// ===========================================================================
// Deployment retrieval tests
// ===========================================================================

void describe('GET /deployments/:deploymentId', () => {
  void it('returns full deployment details', async () => {
    const { body: { application } } = await createTestApp();
    const created = await request(app)
      .post(`/applications/${application.id}/deployments`)
      .send(validDeploymentBody());
    assert.equal(created.status, 201);
    const deploymentId: string = created.body.deployment.id;

    const res = await request(app).get(`/deployments/${deploymentId}`);
    assert.equal(res.status, 200);
    const dep = res.body.deployment;
    assert.equal(dep.id, deploymentId);
    assert.equal(dep.applicationId, application.id);
    assert.equal(dep.status, 'PENDING');
    assert.equal(dep.revision, 0);
    assert.ok(dep.targetImage);
    assert.ok(dep.strategy);
    assert.ok(dep.createdAt);
    assert.ok(dep.updatedAt);
    // Traffic is null while no stage is active
    assert.equal(dep.currentStage, null);
    assert.equal(dep.currentStageIndex, null);
  });

  void it('returns 404 for unknown deployment', async () => {
    const res = await request(app).get('/deployments/00000000-0000-0000-0000-000000000000');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'DEPLOYMENT_NOT_FOUND');
  });

  void it('distinguishes desiredCanaryPct from observedCanaryPct', async () => {
    const { body: { application } } = await createTestApp();
    const created = await request(app)
      .post(`/applications/${application.id}/deployments`)
      .send(validDeploymentBody());
    const deploymentId: string = created.body.deployment.id;

    // Manually create a stage to simulate a deployment in CANARY
    await prisma.deploymentStage.create({
      data: {
        deploymentId,
        stageIndex: 0,
        desiredCanaryPct: 10,
        desiredStablePct: 90,
        appliedCanaryPct: 10,
        appliedStablePct: 90,
        observedCanaryPct: null, // not yet verified
        observedStablePct: null,
        status: 'APPLYING',
        applyAttempt: 1,
      },
    });
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { status: DeploymentStatus.CANARY, currentStageIndex: 0 },
    });

    const res = await request(app).get(`/deployments/${deploymentId}`);
    assert.equal(res.status, 200);
    const stage = res.body.deployment.currentStage;
    assert.ok(stage, 'should have currentStage');
    assert.equal(stage.desiredCanaryPct, 10, 'desired canary pct must be 10');
    assert.equal(stage.observedCanaryPct, null, 'observed must be null when not verified');
  });
});

void describe('GET /deployments/:deploymentId/status', () => {
  void it('returns lightweight status view', async () => {
    const { body: { application } } = await createTestApp();
    const created = await request(app)
      .post(`/applications/${application.id}/deployments`)
      .send(validDeploymentBody());
    const deploymentId: string = created.body.deployment.id;

    const res = await request(app).get(`/deployments/${deploymentId}/status`);
    assert.equal(res.status, 200);
    const status = res.body.status;
    assert.equal(status.id, deploymentId);
    assert.equal(status.applicationId, application.id);
    assert.equal(status.status, 'PENDING');
    assert.equal(status.revision, 0);
    assert.ok(status.targetImage);
    assert.ok(status.updatedAt);
    // No active stage yet
    assert.equal(status.currentStageIndex, null);
    assert.equal(status.desiredCanaryPct, null);
    assert.equal(status.observedCanaryPct, null);
  });

  void it('returns 404 for unknown deployment', async () => {
    const res = await request(app).get('/deployments/00000000-0000-0000-0000-000000000000/status');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'DEPLOYMENT_NOT_FOUND');
  });
});

// ===========================================================================
// Transaction integrity tests
// ===========================================================================

void describe('Transaction integrity', () => {
  void it('does not create a partial deployment when application is missing', async () => {
    const fakeId = '00000000-0000-0000-0000-999999999999';
    const requestIdentity = `partial-${uid()}`;

    const res = await request(app)
      .post(`/applications/${fakeId}/deployments`)
      .send(validDeploymentBody({ requestIdentity }));
    assert.equal(res.status, 404);

    // Verify no orphan deployment row was created
    const orphan = await prisma.deployment.findFirst({
      where: { requestIdentity },
    });
    assert.equal(orphan, null, 'no orphan deployment should exist');
  });
});
