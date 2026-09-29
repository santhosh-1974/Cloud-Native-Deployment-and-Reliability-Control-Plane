import express from 'express';
import { healthHandler } from './api/health';
import { requestContext } from './api/request-context';
import { errorHandler } from './errors/error-handler';
import { AppError } from './errors/app-error';
export const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(requestContext);
app.get('/health', healthHandler);
if (process.env.NODE_ENV === 'test') {
  app.get('/__test/expected-error', (_req, _res, next) => next(new AppError(400, 'Invalid request', 'INVALID_REQUEST')));
  app.get('/__test/unexpected-error', (_req, _res, next) => next(new Error('private stack detail')));
}
app.use(errorHandler);
