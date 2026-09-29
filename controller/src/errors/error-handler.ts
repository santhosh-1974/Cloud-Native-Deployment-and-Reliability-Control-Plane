import type { ErrorRequestHandler } from 'express';
import { AppError } from './app-error';
import { logger } from '../infrastructure/logger';
import { config } from '../config/config';
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (error instanceof AppError) { res.status(error.statusCode).json({ error: { code: error.code, message: error.message }, requestId: req.requestId }); return; }
  logger.error('unexpected_error', { requestId: req.requestId, error: error instanceof Error ? error.message : String(error), ...(config.nodeEnv !== 'production' && error instanceof Error ? { stack: error.stack } : {}) });
  res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred' }, requestId: req.requestId });
};
