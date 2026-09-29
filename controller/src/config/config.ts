export interface AppConfig { nodeEnv: 'development' | 'test' | 'production'; port: number; databaseUrl?: string; redisUrl?: string }
function optionalValue(name: string): string | undefined { const value = process.env[name]?.trim(); return value ? value : undefined; }
function parsePort(raw: string | undefined): number { if (raw === undefined || raw === '') return 3000; const parsed = Number(raw); if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error('PORT must be an integer between 1 and 65535'); return parsed; }
const nodeEnv = process.env.NODE_ENV ?? 'development';
if (!['development', 'test', 'production'].includes(nodeEnv)) throw new Error('NODE_ENV must be development, test, or production');
const databaseUrl = optionalValue('DATABASE_URL');
const redisUrl = optionalValue('REDIS_URL');
export const config: AppConfig = { nodeEnv: nodeEnv as AppConfig['nodeEnv'], port: parsePort(process.env.PORT), ...(databaseUrl ? { databaseUrl } : {}), ...(redisUrl ? { redisUrl } : {}) };
