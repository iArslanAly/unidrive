import { Router } from 'express'
import http from 'node:http'
import https from 'node:https'
import { google } from 'googleapis'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { decryptText, encryptText, hashToken, randomToken } from '../../utils/crypto.js'
import { hashPassword } from '../../utils/password.js'
import { createOAuthClient, syncGoogleQuota } from '../google/google.service.js'
import { syncS3Quota, testS3Connection } from '../s3/s3.service.js'

// Persistent keep-alive sockets for outbound HTTPS (Google OAuth/Drive). Frequent
// short-lived connections were triggering `ECONNRESET` / `terminated` errors during
// the token exchange. Node 20+ defaults to keep-alive, but we pin it explicitly
// with a generous timeout and socket ceiling so concurrent refreshes reuse sockets.
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, timeout: 60_000, maxSockets: 64 })
const keepAliveHttpAgent = new http.Agent({ keepAlive: true, timeout: 60_000, maxSockets: 64 })
https.globalAgent = keepAliveHttpsAgent
http.globalAgent = keepAliveHttpAgent

/**
 * True when an error looks like a transient network drop rather than a permanent
 * failure (bad code, invalid_grant). Google's token endpoint occasionally resets
 * the socket mid-request (`ECONNRESET`, `socket hang up`, `terminated`); these are
 * safe to retry because the exchange never completed.
 */
function isTransientNetworkError(error: unknown): boolean {
  const code = (error as { code?: string })?.code
  if (code && ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'ESOCKETTIMEDOUT'].includes(code)) return true
  const message = String((error as { message?: string })?.message ?? '').toLowerCase()
  return message.includes('econnreset') || message.includes('socket hang up') || message.includes('terminated') || message.includes('network')
}

/** Retries a promise-producing fn up to `attempts` times on transient network errors. */
async function withNetworkRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (!isTransientNetworkError(error) || i === attempts - 1) throw error
      const backoff = 300 * 2 ** i // 300ms, 600ms
      await new Promise((resolve) => setTimeout(resolve, backoff))
    }
  }
  throw lastError
}

/** Popup-friendly HTML error page for interrupted Google connects. */
function googleInterruptedErrorPage() {
  return `<!DOCTYPE html>
<html>
  <head><title>Connection Interrupted - UniDrive</title></head>
  <body style="background:#09090b;color:#f87171;font-family:sans-serif;text-align:center;padding:40px;">
    <h3>Connection to Google was interrupted.</h3>
    <p>Please close this window and try connecting again.</p>
  </body>
</html>`
}

export const connectedAccountRouter = Router()

const s3ConnectSchema = z.object({
  name: z.string().trim().min(1).max(191),
  bucket: z.string().trim().min(1).max(191),
  region: z.string().trim().min(1).max(191),
  endpoint: z.string().url().optional().or(z.literal('')),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  forcePathStyle: z.boolean().optional(),
  quotaBytes: z.string().regex(/^\d+$/).optional().nullable(),
})

async function syncQuotaForAccount(account: { id: string; provider: string }) {
  if (account.provider === 's3') return syncS3Quota(account.id)
  return syncGoogleQuota(account.id)
}

type StorageAccountRow = {
  totalBytes: bigint | null
  usedBytes: bigint
  availableBytes: bigint | null
  trashBytes: bigint | null
}

type SerializableConnectedAccount = {
  accessTokenEncrypted: string | null
  refreshTokenEncrypted: string | null
  usedSpace: bigint
  allocatedSpace: bigint | null
  storageAccount?: StorageAccountRow | null
}

/**
 * Prepares a connected-account row for a JSON response: encrypted token
 * material is never sent to clients, and every BigInt column (usedSpace,
 * allocatedSpace, quota bytes) is converted to a string because `res.json`
 * throws `Do not know how to serialize a BigInt`. Without this, the list
 * endpoint 500s while `/storage/summary` succeeds, desyncing the sidebar
 * "connected drives" state from the displayed quota.
 */
function serializeConnectedAccount(
  account: SerializableConnectedAccount,
  storageAccount: StorageAccountRow | null | undefined = account.storageAccount,
) {
  const { accessTokenEncrypted: _a, refreshTokenEncrypted: _r, storageAccount: _sa, ...rest } = account
  return {
    ...rest,
    usedSpace: account.usedSpace.toString(),
    allocatedSpace: account.allocatedSpace?.toString() ?? null,
    storageAccount: storageAccount
      ? {
        ...storageAccount,
        totalBytes: storageAccount.totalBytes?.toString() ?? null,
        usedBytes: storageAccount.usedBytes.toString(),
        availableBytes: storageAccount.availableBytes?.toString() ?? null,
        trashBytes: storageAccount.trashBytes?.toString() ?? null,
      }
      : null,
  }
}

connectedAccountRouter.get('/', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const accounts = await prisma.connectedAccount.findMany({
      where: { userId: req.user!.id, status: 'connected' },
      include: { storageAccount: true },
      orderBy: { createdAt: 'desc' },
    })
    const missingQuota = accounts.filter((account) => !account.storageAccount?.lastSyncedAt)
    for (const account of missingQuota) await syncQuotaForAccount(account).catch(() => undefined)

    const syncedAccounts = missingQuota.length > 0
      ? await prisma.connectedAccount.findMany({
        where: { userId: req.user!.id, status: 'connected' },
        include: { storageAccount: true },
        orderBy: { createdAt: 'desc' },
      })
      : accounts

    return res.json({
      accounts: syncedAccounts.map((account) => serializeConnectedAccount(account)),
    })
  } catch (error) {
    return next(error)
  }
})

async function createGoogleConnectUrl(req: AuthRequest) {
  const query = z.object({ providerConfigId: z.string().min(1).optional() }).parse(req.query)
  const config = query.providerConfigId
    ? await prisma.providerConfig.findFirstOrThrow({ where: { id: query.providerConfigId, OR: [{ userId: req.user!.id }, { userId: null }], provider: 'google_drive', status: 'active' } })
    : await prisma.providerConfig.findFirstOrThrow({ where: { userId: null, provider: 'google_drive', status: 'active' }, orderBy: { createdAt: 'desc' } })
  const state = randomToken()
  await prisma.oauthState.create({ data: { userId: req.user!.id, providerConfigId: config.id, flow: 'connect', stateHash: hashToken(state), expiresAt: new Date(Date.now() + 10 * 60_000) } })
  const client = createOAuthClient(config)
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: config.scopes as string[],
    state,
  })
}

connectedAccountRouter.post('/s3', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = s3ConnectSchema.parse(req.body)
    const providerConfig = await prisma.providerConfig.findFirstOrThrow({ where: { provider: 'google_drive', status: 'active' }, orderBy: { createdAt: 'desc' } })
    const providerAccountId = `${body.bucket}:${body.endpoint || body.region}`
    const existingAccount = await prisma.connectedAccount.findUnique({ where: { userId_provider_providerAccountId: { userId: req.user!.id, provider: 's3', providerAccountId } } })
    const account = existingAccount
      ? await prisma.connectedAccount.update({
        where: { id: existingAccount.id },
        data: {
          providerConfigId: providerConfig.id,
          email: `${body.bucket} (S3)`,
          displayName: body.name,
          accessTokenEncrypted: encryptText('s3'),
          refreshTokenEncrypted: encryptText(randomToken()),
          tokenExpiresAt: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
          scopes: [],
          status: 'connected',
        },
      })
      : await prisma.connectedAccount.create({ data: {
        userId: req.user!.id,
        providerConfigId: providerConfig.id,
        provider: 's3',
        providerAccountId,
        email: `${body.bucket} (S3)`,
        displayName: body.name,
        accessTokenEncrypted: encryptText('s3'),
        refreshTokenEncrypted: encryptText(randomToken()),
        tokenExpiresAt: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
        scopes: [],
        status: 'connected',
      } })
    const config = await prisma.s3StorageConfig.upsert({
      where: { connectedAccountId: account.id },
      create: {
        userId: req.user!.id,
        connectedAccountId: account.id,
        name: body.name,
        bucket: body.bucket,
        region: body.region,
        endpoint: body.endpoint || null,
        accessKeyIdEncrypted: encryptText(body.accessKeyId),
        secretAccessKeyEncrypted: encryptText(body.secretAccessKey),
        forcePathStyle: body.forcePathStyle ?? Boolean(body.endpoint),
        quotaBytes: body.quotaBytes ? BigInt(body.quotaBytes) : null,
      },
      update: {
        name: body.name,
        bucket: body.bucket,
        region: body.region,
        endpoint: body.endpoint || null,
        accessKeyIdEncrypted: encryptText(body.accessKeyId),
        secretAccessKeyEncrypted: encryptText(body.secretAccessKey),
        forcePathStyle: body.forcePathStyle ?? Boolean(body.endpoint),
        quotaBytes: body.quotaBytes ? BigInt(body.quotaBytes) : null,
        status: 'active',
      },
    })
    try {
      await testS3Connection(config)
      const quota = await syncS3Quota(account.id)
      return res.status(201).json({
        account: serializeConnectedAccount(account, quota),
      })
    } catch (error) {
      if (!existingAccount) await prisma.connectedAccount.delete({ where: { id: account.id } }).catch(() => undefined)
      throw error
    }
  } catch (error) {
    return next(error)
  }
})

connectedAccountRouter.get('/google/connect-url', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const url = await createGoogleConnectUrl(req)
    return res.json({ url })
  } catch (error) {
    return next(error)
  }
})

connectedAccountRouter.get('/google/connect', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const url = await createGoogleConnectUrl(req)
    return res.redirect(url)
  } catch (error) {
    return next(error)
  }
})

connectedAccountRouter.get('/google/callback', async (req, res, next) => {
  try {
    const query = z.object({ code: z.string(), state: z.string() }).parse(req.query)
    const oauthState = await prisma.oauthState.findUniqueOrThrow({ where: { stateHash: hashToken(query.state) }, include: { providerConfig: true } })
    if (oauthState.usedAt || oauthState.expiresAt < new Date()) return res.status(400).json({ code: 'GOOGLE_OAUTH_STATE_INVALID', message: 'OAuth state expired.' })
    const client = createOAuthClient(oauthState.providerConfig)
    // Google occasionally resets the socket mid-exchange (ECONNRESET / terminated).
    // Retry transient network drops with exponential backoff before giving up.
    const tokenResult = await withNetworkRetry(() => client.getToken(query.code), 3)
    const tokens = tokenResult.tokens
    if (!tokens.access_token) return res.status(400).json({ code: 'GOOGLE_OAUTH_FAILED', message: 'Google did not return required tokens.' })
    client.setCredentials(tokens)
    const oauth2 = google.oauth2({ version: 'v2', auth: client })
    const profile = await oauth2.userinfo.get()
    const providerAccountId = profile.data.id
    const email = profile.data.email
    if (!providerAccountId || !email) return res.status(400).json({ code: 'GOOGLE_PROFILE_FAILED', message: 'Google profile missing id or email.' })

    if (oauthState.flow === 'login') {
      const name = profile.data.name || email.split('@')[0] || 'Google User'
      const user = await prisma.user.upsert({
        where: { email },
        create: { email, name, passwordHash: await hashPassword(randomToken(32)) },
        update: { name },
      })
      const existingAccount = await prisma.connectedAccount.findUnique({ where: { userId_provider_providerAccountId: { userId: user.id, provider: 'google_drive', providerAccountId } } })
      const refreshTokenEncrypted = tokens.refresh_token ? encryptText(tokens.refresh_token) : existingAccount?.refreshTokenEncrypted
      if (!refreshTokenEncrypted) {
        console.error('Google login failed: no refresh token received and no existing account. Has refresh_token:', !!tokens.refresh_token)
        return res.redirect(`${env.FRONTEND_URL}/google-auth?status=error`)
      }
      const account = await prisma.connectedAccount.upsert({
        where: { userId_provider_providerAccountId: { userId: user.id, provider: 'google_drive', providerAccountId } },
        create: {
          userId: user.id,
          providerConfigId: oauthState.providerConfigId,
          provider: 'google_drive',
          providerAccountId,
          email,
          displayName: profile.data.name,
          avatarUrl: profile.data.picture,
          accessTokenEncrypted: encryptText(tokens.access_token),
          refreshTokenEncrypted,
          tokenExpiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
          scopes: oauthState.providerConfig.scopes as string[],
          status: 'connected',
        },
        update: {
          providerConfigId: oauthState.providerConfigId,
          email,
          displayName: profile.data.name,
          avatarUrl: profile.data.picture,
          accessTokenEncrypted: encryptText(tokens.access_token),
          refreshTokenEncrypted,
          tokenExpiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
          scopes: oauthState.providerConfig.scopes as string[],
          status: 'connected',
        },
      })
      await prisma.oauthState.update({ where: { id: oauthState.id }, data: { usedAt: new Date(), userId: user.id } })
      await syncGoogleQuota(account.id).catch(() => undefined)
      const handoffToken = randomToken()
      await prisma.authHandoff.create({ data: { userId: user.id, tokenHash: hashToken(handoffToken), expiresAt: new Date(Date.now() + 5 * 60_000) } })
      return res.redirect(`${env.FRONTEND_URL}/google-auth?token=${handoffToken}`)
    }

    if (oauthState.flow !== 'connect' || !oauthState.userId) return res.status(400).json({ code: 'GOOGLE_OAUTH_STATE_INVALID', message: 'OAuth state expired.' })
    const existingAccount = await prisma.connectedAccount.findUnique({ where: { userId_provider_providerAccountId: { userId: oauthState.userId, provider: 'google_drive', providerAccountId } } })
    const refreshTokenEncrypted = tokens.refresh_token ? encryptText(tokens.refresh_token) : existingAccount?.refreshTokenEncrypted
    if (!refreshTokenEncrypted) return res.status(400).json({ code: 'GOOGLE_OAUTH_FAILED', message: 'Google did not return required tokens.' })

    const account = await prisma.connectedAccount.upsert({
      where: { userId_provider_providerAccountId: { userId: oauthState.userId, provider: 'google_drive', providerAccountId } },
      create: {
        userId: oauthState.userId,
        providerConfigId: oauthState.providerConfigId,
        provider: 'google_drive',
        providerAccountId,
        email,
        displayName: profile.data.name,
        avatarUrl: profile.data.picture,
        accessTokenEncrypted: encryptText(tokens.access_token),
        refreshTokenEncrypted,
        tokenExpiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
        scopes: oauthState.providerConfig.scopes as string[],
        status: 'connected',
      },
      update: {
        providerConfigId: oauthState.providerConfigId,
        email,
        displayName: profile.data.name,
        avatarUrl: profile.data.picture,
        accessTokenEncrypted: encryptText(tokens.access_token),
        refreshTokenEncrypted,
        tokenExpiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
        scopes: oauthState.providerConfig.scopes as string[],
        status: 'connected',
      },
    })
    await prisma.oauthState.update({ where: { id: oauthState.id }, data: { usedAt: new Date() } })
    await syncGoogleQuota(account.id)
    // Popup-aware handshake: notify the opener immediately so the dashboard can
    // refetch accounts/quota without a manual hard refresh. Falls back to the
    // /google-connected page when the OAuth flow ran in the same window.
    const successRedirect = `${env.FRONTEND_URL}/google-connected?status=success`
    return res.status(200).type('html').send(`<!DOCTYPE html>
<html>
  <head><title>Account Connected - UniDrive</title></head>
  <body style="background:#09090b;color:#a1a1aa;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
    <p>Account connected successfully. Closing...</p>
    <script>
      (function () {
        try {
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage({ type: 'UNIDRIVE_OAUTH_SUCCESS', provider: 'google' }, ${JSON.stringify(env.FRONTEND_URL)});
            setTimeout(function () { window.close(); }, 600);
          } else {
            window.location.replace(${JSON.stringify(successRedirect)});
          }
        } catch (err) {
          console.error('Failed to notify parent window:', err);
          window.location.replace(${JSON.stringify(successRedirect)});
        }
      })();
    </script>
  </body>
</html>`)
  } catch (error) {
    console.error('Google OAuth callback failed:', error)
    // Render a friendly popup page for interrupted/failed connects instead of
    // redirecting or crashing. Keep the legacy redirect as a fallback path for
    // non-network errors where the redirect target is more appropriate.
    if (isTransientNetworkError(error)) {
      if (!res.headersSent) return res.status(502).type('html').send(googleInterruptedErrorPage())
      return
    }
    if (!res.headersSent) return res.redirect(`${env.FRONTEND_URL}/google-connected?status=error`)
    return
  }
})

connectedAccountRouter.post('/:id/sync-quota', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const accountId = String(req.params.id)
    const account = await prisma.connectedAccount.findFirstOrThrow({ where: { id: accountId, userId: req.user!.id } })
    const quota = await syncQuotaForAccount(account)
    return res.json({
      quota: {
        ...quota,
        totalBytes: quota.totalBytes?.toString() ?? null,
        usedBytes: quota.usedBytes.toString(),
        availableBytes: quota.availableBytes?.toString() ?? null,
        trashBytes: quota.trashBytes?.toString() ?? null,
      },
    })
  } catch (error) {
    return next(error)
  }
})

connectedAccountRouter.delete('/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const accountId = String(req.params.id)
    await prisma.connectedAccount.updateMany({ where: { id: accountId, userId: req.user!.id }, data: { status: 'disconnected' } })
    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})
