import { app } from './app.js'
import { env } from './config/env.js'
import { applySqlitePragmas } from './config/prisma.js'

const port = env.APP_PORT ?? env.PORT

// A missed promise rejection must never crash the upload pipeline mid-stream:
// an exiting process drops the socket and the browser reports
// "NetworkError when attempting to fetch resource." Log it instead.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? (reason.stack ?? reason.message) : reason)
})

async function startServer() {
  // Configure SQLite concurrency (WAL + busy timeout) before serving traffic
  // so parallel chunk writes never race into SQLITE_BUSY lock errors.
  await applySqlitePragmas()

  const server = app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`)
  })
  // Large single/chunked uploads stream for minutes: never kill an idle socket
  // mid-transfer and allow request bodies up to 15 minutes.
  server.timeout = 0
  server.requestTimeout = 15 * 60 * 1000
}

startServer().catch((error) => {
  console.error('Failed to start server:', error)
  process.exit(1)
})
