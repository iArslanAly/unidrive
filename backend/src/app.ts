import cors from 'cors'
import express from 'express'
import { env } from './config/env.js'
import { errorMiddleware } from './middleware/error.middleware.js'
import { authRouter } from './modules/auth/auth.routes.js'
import { providerConfigRouter } from './modules/provider-configs/provider-config.routes.js'
import { connectedAccountRouter } from './modules/connected-accounts/connected-account.routes.js'
import { storageRouter } from './modules/storage/storage.routes.js'
import { uploadRouter } from './modules/uploads/upload.routes.js'
import { fileRouter } from './modules/files/file.routes.js'
import { folderRouter } from './modules/folders/folder.routes.js'
import { publicRouter } from './modules/public/public.routes.js'
import { inviteRouter } from './modules/invites/invite.routes.js'
import { apiKeyRouter } from './modules/api-keys/api-key.routes.js'
import { publicApiRouter } from './modules/public-api/public-api.routes.js'
import { auditLogRouter } from './modules/audit-logs/audit-log.routes.js'
import { systemRouter } from './modules/system/system.routes.js'
import { vaultRouter } from './modules/vault/vault.routes.js'

export const app = express()
app.set('trust proxy', true)

// CORS: explicit allow-list for the local frontend, including pre-flight OPTIONS.
app.use(cors({
  origin: env.FRONTEND_URL,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With', 'X-Request-Id'],
}))

// JSON body parsing must run before any route handler.
app.use(express.json({ limit: '1mb' }))

app.get('/health', (_req, res) => res.json({ status: 'ok' }))

// All API routes live under /api so the frontend base URL is `http://<host>:<port>/api`.
app.use('/api', publicApiRouter)
app.use('/api/public', publicRouter)
app.use('/api/auth', authRouter)
app.use('/api/api-keys', apiKeyRouter)
app.use('/api/provider-configs', providerConfigRouter)
app.use('/api/connected-accounts', connectedAccountRouter)
app.use('/api/storage', storageRouter)
app.use('/api/uploads', uploadRouter)
app.use('/api/files', fileRouter)
app.use('/api/folders', folderRouter)
app.use('/api/invites', inviteRouter)
app.use('/api/audit-logs', auditLogRouter)
app.use('/api/system', systemRouter)
app.use('/api/vault', vaultRouter)
app.use(errorMiddleware)
