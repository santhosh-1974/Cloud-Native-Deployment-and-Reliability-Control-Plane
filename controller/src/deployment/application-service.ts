/**
 * Application service — business logic for application registration and retrieval.
 *
 * All database operations go through this module so that route handlers stay
 * thin and contain no SQL or Prisma calls directly.
 */
import type { Application } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma-client.js';
import { Errors } from '../errors/domain-errors.js';
import { AppError } from '../errors/app-error.js';
import { logger } from '../infrastructure/logger.js';

export interface ApplicationView {
  id: string;
  name: string;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function toView(app: Application): ApplicationView {
  return {
    id: app.id,
    name: app.name,
    config: app.config as Record<string, unknown>,
    createdAt: app.createdAt.toISOString(),
    updatedAt: app.updatedAt.toISOString(),
  };
}

/**
 * Register a new application.
 *
 * Throws `AppError(409, DUPLICATE_APPLICATION_NAME)` when the name is already taken.
 */
export async function registerApplication(
  name: string,
  config: Record<string, unknown> = {},
): Promise<ApplicationView> {
  try {
    const app = await prisma.application.create({
      data: { name, config: config as Prisma.InputJsonValue },
    });
    logger.info('application_registered', { applicationId: app.id, name: app.name });
    return toView(app);
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      throw new AppError(
        409,
        `Application name '${name}' is already registered`,
        'DUPLICATE_APPLICATION_NAME',
      );
    }
    throw err;
  }
}

/**
 * Retrieve an application by ID.
 *
 * Throws `AppError(404, APPLICATION_NOT_FOUND)` when the application does not exist.
 */
export async function getApplication(id: string): Promise<ApplicationView> {
  const app = await prisma.application.findUnique({ where: { id } });
  if (!app) throw Errors.applicationNotFound(id);
  return toView(app);
}
