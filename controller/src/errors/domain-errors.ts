/**
 * Domain errors for the Deployment Control Plane API.
 *
 * These map 1-to-1 onto HTTP response codes and error codes the API surface
 * exposes.  The base `AppError` class already exists; this module exports
 * pre-baked factory functions so route handlers don't scatter magic numbers.
 */
import { AppError } from './app-error.js';

export const Errors = {
  applicationNotFound: (id: string) =>
    new AppError(404, `Application '${id}' not found`, 'APPLICATION_NOT_FOUND'),

  deploymentNotFound: (id: string) =>
    new AppError(404, `Deployment '${id}' not found`, 'DEPLOYMENT_NOT_FOUND'),

  validationError: (message: string) =>
    new AppError(400, message, 'VALIDATION_ERROR'),

  duplicateRequest: (existingId: string) =>
    new AppError(409, `Deployment already exists for this request identity: ${existingId}`, 'DUPLICATE_REQUEST'),

  activeDeploymentConflict: (applicationId: string) =>
    new AppError(
      409,
      `Application '${applicationId}' already has an active deployment. Only one non-terminal deployment is permitted per application.`,
      'ACTIVE_DEPLOYMENT_CONFLICT',
    ),
};
