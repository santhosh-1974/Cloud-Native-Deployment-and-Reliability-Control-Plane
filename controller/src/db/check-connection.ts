import { PrismaClient } from '@prisma/client';
async function main(): Promise<void> { const prisma = new PrismaClient(); try { await prisma.$queryRaw`SELECT 1`; console.log('PostgreSQL connectivity: ok'); } finally { await prisma.$disconnect(); } }
main().catch((error: unknown) => { console.error('PostgreSQL connectivity: failed', error); process.exitCode = 1; });
