/**
 * Application route handlers.
 *
 * POST /applications          — register an application
 * GET  /applications/:id      — retrieve an application
 */
import type { Request, Response, NextFunction } from 'express';
import { validateRegisterApplication } from './validation.js';
import { registerApplication, getApplication } from '../deployment/application-service.js';
import { Errors } from '../errors/domain-errors.js';

/**
 * POST /applications
 */
export async function postApplication(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = validateRegisterApplication(req.body);
    if (!result.ok) {
      next(Errors.validationError(result.error));
      return;
    }

    const app = await registerApplication(result.value.name, result.value.config);
    res.status(201).json({ application: app });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /applications/:applicationId
 */
export async function getApplicationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const applicationId = typeof req.params['applicationId'] === 'string' ? req.params['applicationId'] : '';
    if (!applicationId) {
      next(Errors.validationError('applicationId path parameter is required'));
      return;
    }
    const app = await getApplication(applicationId);
    res.status(200).json({ application: app });
  } catch (err) {
    next(err);
  }
}
