import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient()

/**
 * SQLite uses a single-writer locking model, so concurrent chunk uploads can
 * fail with SQLITE_BUSY unless the connection enables WAL journalling and a
 * busy timeout. Applied once per process before the HTTP server starts
 * accepting traffic (see server.ts).
 */
export async function applySqlitePragmas() {
  try {
    // $queryRawUnsafe is required because journal_mode returns a result row in SQLite
    await prisma.$queryRawUnsafe(`PRAGMA journal_mode = WAL;`)
    await prisma.$queryRawUnsafe(`PRAGMA busy_timeout = 5000;`)
    await prisma.$queryRawUnsafe(`PRAGMA synchronous = NORMAL;`)
  } catch (error) {
    console.warn('Warning: Failed to set SQLite PRAGMAs:', error)
  }
}
