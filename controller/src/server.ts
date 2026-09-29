import { app } from './app';
import { config } from './config/config';
import { logger } from './infrastructure/logger';
const server = app.listen(config.port, () => logger.info('server_started', { port: config.port, environment: config.nodeEnv }));
function shutdown(signal: string): void { logger.info('server_shutdown_started', { signal }); server.close((error) => { if (error) { logger.error('server_shutdown_failed', { error: error.message }); process.exitCode = 1; } }); }
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
