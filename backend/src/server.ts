import { app } from './app.js'
import { env } from './config/env.js'
import { applySqlitePragmas } from './config/prisma.js'

const port = env.APP_PORT ?? env.PORT

async function startServer() {
  // Configure SQLite concurrency (WAL + busy timeout) before serving traffic
  // so parallel chunk writes never race into SQLITE_BUSY lock errors.
  await applySqlitePragmas()

  app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`)
  })
}

startServer().catch((error) => {
  console.error('Failed to start server:', error)
  process.exit(1)
})
