import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../infrastructure/logger';
declare global { namespace Express { interface Request { requestId: string } } }
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.header('x-request-id');
  const requestId = supplied && UUID_PATTERN.test(supplied) ? supplied : randomUUID();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  res.on('finish', () => logger.info('http_request', { requestId, method: req.method, path: req.path, statusCode: res.statusCode }));
  next();
}
