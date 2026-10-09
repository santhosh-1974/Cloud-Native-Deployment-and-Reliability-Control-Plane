/**
 * Singleton Prisma client.
 *
 * The client is created once and reused across the application lifecycle.
 * In test mode each test file can import this module and rely on the same
 * connection pool rather than creating independent clients.
 */
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();
