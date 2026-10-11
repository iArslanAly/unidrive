import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { streamVaultVirtualFile } from './vault-stream.js'
import { buildVaultManifest, restoreVaultManifest, syncVaultManifest, VAULT_MANIFEST_NAME } from './vault-manifest.service.js'

export const vaultRouter = Router()

vaultRouter.use(requireAuth)

/**
 * GET /api/v1/vault/stream/:fileId
 * Universal media streaming: 302 to the provider CDN for intact single-account
 * files, HTTP 206 range assembly across chunks otherwise (video seeking).
 */
vaultRouter.get('/stream/:fileId', async (req: AuthRequest, res, next) => {
  try {
    await streamVaultVirtualFile(req.user!.id, String(req.params.fileId), req.headers.range, res, { disposition: 'inline', allowRedirect: true })
  } catch (error) {
    return next(error)
  }
})

/**
 * GET /api/v1/vault/download/:fileId
 * Sequential piped chunks with no full buffering; keeps the original filename.
 */
vaultRouter.get('/download/:fileId', async (req: AuthRequest, res, next) => {
  try {
    await streamVaultVirtualFile(req.user!.id, String(req.params.fileId), req.headers.range, res, { disposition: 'attachment', allowRedirect: false })
  } catch (error) {
    return next(error)
  }
})

/** GET /api/v1/vault/manifest — export the sealed `.vault_manifest.json` document. */
vaultRouter.get('/manifest', async (req: AuthRequest, res, next) => {
  try {
    const manifest = await buildVaultManifest(req.user!.id)
    return res.json({ manifest })
  } catch (error) {
    return next(error)
  }
})

/** POST /api/v1/vault/manifest/sync — verify every chunk against its provider; mark lost files. */
vaultRouter.post('/manifest/sync', async (req: AuthRequest, res, next) => {
  try {
    const manifest = await buildVaultManifest(req.user!.id)
    const report = await syncVaultManifest(req.user!.id, manifest)
    return res.json({ report, manifest })
  } catch (error) {
    return next(error)
  }
})

const restoreSchema = z.object({ manifest: z.any(), adoptAccounts: z.boolean().optional() })

/** POST /api/v1/vault/manifest/restore — rebuild vault rows from an uploaded manifest. */
vaultRouter.post('/manifest/restore', async (req: AuthRequest, res, next) => {
  try {
    const body = restoreSchema.parse(req.body)
    const report = await restoreVaultManifest(req.user!.id, body.manifest, { adoptAccounts: body.adoptAccounts ?? false })
    return res.json({ status: 'ok', manifestName: VAULT_MANIFEST_NAME, report })
  } catch (error) {
    return next(error)
  }
})
