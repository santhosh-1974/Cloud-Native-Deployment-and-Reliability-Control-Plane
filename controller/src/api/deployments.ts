/**
 * Deployment route handlers.
 *
 * POST /applications/:applicationId/deployments   — create deployment
 * GET  /deployments/:deploymentId                 — full deployment details
 * GET  /deployments/:deploymentId/status          — lightweight status view
 */
import type { Request, Response, NextFunction } from 'express';
import { validateCreateDeployment } from './validation.js';
import {
  createDeployment,
  getDeployment,
  getDeploymentStatus,
} from '../deployment/deployment-service.js';
import { Errors } from '../errors/domain-errors.js';

function param(req: Request, name: string): string {
  const v = req.params[name];
  return typeof v === 'string' ? v : '';
}

/**
 * POST /applications/:applicationId/deployments
 */
export async function postDeployment(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const applicationId = param(req, 'applicationId');
    if (!applicationId) {
      next(Errors.validationError('applicationId path parameter is required'));
      return;
    }

    const result = validateCreateDeployment(req.body);
    if (!result.ok) {
      next(Errors.validationError(result.error));
      return;
    }

    const deployment = await createDeployment(applicationId, result.value);
    res.status(201).json({ deployment });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /deployments/:deploymentId
 */
export async function getDeploymentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const deploymentId = param(req, 'deploymentId');
    if (!deploymentId) {
      next(Errors.validationError('deploymentId path parameter is required'));
      return;
    }
    const deployment = await getDeployment(deploymentId);
    res.status(200).json({ deployment });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /deployments/:deploymentId/status
 */
export async function getDeploymentStatusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const deploymentId = param(req, 'deploymentId');
    if (!deploymentId) {
      next(Errors.validationError('deploymentId path parameter is required'));
      return;
    }
    const status = await getDeploymentStatus(deploymentId);
    res.status(200).json({ status });
  } catch (err) {
    next(err);
  }
}
