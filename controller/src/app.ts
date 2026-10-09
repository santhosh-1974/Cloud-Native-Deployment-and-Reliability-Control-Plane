import express from 'express';
import { healthHandler } from './api/health.js';
import { requestContext } from './api/request-context.js';
import { errorHandler } from './errors/error-handler.js';
import { AppError } from './errors/app-error.js';
import { postApplication, getApplicationHandler } from './api/applications.js';
import { postDeployment, getDeploymentHandler, getDeploymentStatusHandler } from './api/deployments.js';

export const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(requestContext);

// Health
app.get('/health', healthHandler);

// Applications
app.post('/applications', postApplication);
app.get('/applications/:applicationId', getApplicationHandler);

// Deployments (nested under application for creation, top-level for retrieval)
app.post('/applications/:applicationId/deployments', postDeployment);
app.get('/deployments/:deploymentId', getDeploymentHandler);
app.get('/deployments/:deploymentId/status', getDeploymentStatusHandler);

// Test-only routes (stripped from production builds by NODE_ENV check)
if (process.env['NODE_ENV'] === 'test') {
  app.get('/__test/expected-error', (_req, _res, next) => next(new AppError(400, 'Invalid request', 'INVALID_REQUEST')));
  app.get('/__test/unexpected-error', (_req, _res, next) => next(new Error('private stack detail')));
}

app.use(errorHandler);
