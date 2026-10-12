import Busboy from 'busboy'
import type { NextFunction, Response } from 'express'
import { Router } from 'express'
import { Readable } from 'stream'
import { z } from 'zod'
import { google } from 'googleapis'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { ensureGoogleAppFolder, getAuthedGoogleClient, syncGoogleQuota } from '../google/google.service.js'
import { buildS3ObjectKey, getS3ConfigForAccount, syncS3Quota, uploadS3Object } from '../s3/s3.service.js'
import { planUpload, recordWholeFile, resolveVirtualPath, uploadChunkedFile } from '../vault/vault.service.js'
import { createAuditLog } from '../../utils/audit.js'

export const uploadRouter = Router()

/** True when an error is caused by the client disconnecting mid-request (undici `TypeError: terminated`, AbortError, ECONNRESET). */
function isClientAbortError(error: unknown): boolean {
  if ((error as { name?: string })?.name === 'AbortError') return true
  const code = (error as { code?: string })?.code
  if (code && ['ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(code)) return true
  const message = String((error as { message?: string })?.message ?? '').toLowerCase()
  return message.includes('terminated') || message.includes('aborted') || message.includes('premature close') || message.includes('econnreset')
}

type UploadMeta = { fieldName: string; fileName: string; mimeType: string; sizeBytes: bigint; folderId?: string }
/** Routing policy modes: Smart Auto, Priority Waterfall, Rule-Based. */
type RoutingMode = 'auto' | 'priority' | 'rules'
type RoutingTypeRules = { video?: string; document?: string; default?: string }
const DEFAULT_SAFETY_CAP_PERCENT = 85

function logUpload(message: string, metadata?: Record<string, unknown>) {
  console.info('[upload]', message, metadata ?? '')
}

function syncQuotaInBackground(accountId: string, sessionId: string) {
  logUpload('quota sync started', { accountId, sessionId })
  prisma.connectedAccount
    .findUnique({ where: { id: accountId }, select: { provider: true } })
    .then((account) => (account?.provider === 's3' ? syncS3Quota(accountId) : syncGoogleQuota(accountId)))
    .then(() => logUpload('quota sync completed', { accountId, sessionId }))
    .catch((error) => logUpload('quota sync failed', { accountId, sessionId, message: error instanceof Error ? error.message : 'Unknown error' }))
}

/** Registers an intact single-account upload in the vault index (manifest recovery); failures never fail the upload. */
async function trackWholeFile(
  userId: string,
  file: { id: string; name: string; folderId: string | null; sizeBytes: bigint },
  mimeType: string,
  providerEmail: string,
  remoteFileId: string,
) {
  try {
    await recordWholeFile({
      userId,
      fileId: file.id,
      name: file.name,
      virtualPath: await resolveVirtualPath(userId, file.folderId, file.name),
      totalSize: file.sizeBytes,
      mimeType,
      providerEmail,
      remoteFileId,
    })
  } catch (error) {
    logUpload('vault tracking failed', { fileId: file.id, message: error instanceof Error ? error.message : 'Unknown error' })
  }
}

function normalizePriorityAccountIds(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** Legacy rows may hold 'most_available' / 'round_robin'; both map to Smart Auto. */
function normalizeRoutingMode(value: unknown): RoutingMode {
  return value === 'priority' || value === 'rules' ? value : 'auto'
}

function parseTypeRules(value: unknown): RoutingTypeRules {
  if (!value || typeof value !== 'object') return {}
  const raw = value as Record<string, unknown>
  const rules: RoutingTypeRules = {}
  for (const key of ['video', 'document', 'default'] as const) {
    if (typeof raw[key] === 'string' && raw[key]) rules[key] = raw[key] as string
  }
  return rules
}

function clampSafetyCap(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100 ? value : DEFAULT_SAFETY_CAP_PERCENT
}

function byPriority<T extends { account: { id: string; createdAt: Date } }>(items: T[], priorityAccountIds: string[]) {
  const order = new Map(priorityAccountIds.map((id, index) => [id, index]))
  return [...items].sort((a, b) => {
    const aOrder = order.get(a.account.id)
    const bOrder = order.get(b.account.id)
    if (aOrder !== undefined && bOrder !== undefined) return aOrder - bOrder
    if (aOrder !== undefined) return -1
    if (bOrder !== undefined) return 1
    return a.account.createdAt.getTime() - b.account.createdAt.getTime()
  })
}

/** Exported for the routing-engine verification script (src/scripts). */
export async function selectAccount(
  userId: string,
  sizeBytes: bigint,
  reservedBytesByAccount = new Map<string, bigint>(),
  targetAccountId?: string | null,
  mimeType?: string | null,
) {
  const accounts = await prisma.connectedAccount.findMany({
    where: { userId, provider: { in: ['google_drive', 's3'] }, status: 'connected', ...(targetAccountId ? { id: targetAccountId } : {}) },
    include: { storageAccount: true },
  })

  const stale = accounts.filter((account) => !account.storageAccount?.lastSyncedAt || account.storageAccount.lastSyncedAt.getTime() < Date.now() - 5 * 60_000)
  await Promise.allSettled(stale.map(async (account) => {
    try {
      if (account.provider === 's3') {
        await syncS3Quota(account.id)
      } else {
        await syncGoogleQuota(account.id)
      }
    } catch (err: any) {
      console.error(`[upload] failed to sync quota for account ${account.email} (${account.id}):`, err.message || err)
      await prisma.connectedAccount.update({
        where: { id: account.id },
        data: { lastError: err.message || 'Quota sync failed' }
      }).catch(() => undefined)
    }
  }))

  const fresh = await prisma.connectedAccount.findMany({
    where: { userId, provider: { in: ['google_drive', 's3'] }, status: 'connected' },
    include: { storageAccount: true },
  })

  const candidates = fresh.map((account) => ({
    account,
    availableBytes: account.storageAccount?.availableBytes === null || account.storageAccount?.availableBytes === undefined ? null : account.storageAccount.availableBytes - (reservedBytesByAccount.get(account.id) ?? 0n),
  }))
  const fits = ({ availableBytes }: (typeof candidates)[number]) => availableBytes === null || availableBytes >= sizeBytes
  const eligible = candidates.filter(fits)

  if (eligible.length === 0) return null

  // An explicit folder/account pin overrides the routing policy: the file must
  // land where the folder lives (still subject to actually fitting).
  if (targetAccountId) {
    const target = eligible.find((candidate) => candidate.account.id === targetAccountId)
    return target?.account ?? null
  }

  const policy = await prisma.uploadRoutingPolicy.upsert({
    where: { userId },
    create: { userId, mode: 'auto', priorityAccountIds: [], safetyCapPercent: DEFAULT_SAFETY_CAP_PERCENT },
    update: {},
  })
  const mode = normalizeRoutingMode(policy.mode)
  const priorityOrder = normalizePriorityAccountIds(policy.priorityAccountIds)
  const safetyCapPercent = clampSafetyCap(policy.safetyCapPercent)
  const typeRules = parseTypeRules(policy.typeRules)

  // Account Safety Guard: usage percent of a drive including bytes already
  // reserved by concurrent uploads in this request. A null/zero total (S3
  // without a known quota, or an account that never synced) is never capped.
  const usagePercent = (candidate: (typeof eligible)[number]): number | null => {
    const total = candidate.account.storageAccount?.totalBytes
    if (total === null || total === undefined || total <= 0n) return null
    const reserved = reservedBytesByAccount.get(candidate.account.id) ?? 0n
    const used = (candidate.account.storageAccount?.usedBytes ?? 0n) + reserved
    return Number((used * 1000n) / total) / 10
  }
  const underSafetyCap = (candidate: (typeof eligible)[number]) => {
    const percent = usagePercent(candidate)
    return percent === null || percent < safetyCapPercent
  }

  const pickMostFree = (list: typeof eligible) =>
    [...list].sort((a, b) => {
      if (a.availableBytes === null && b.availableBytes === null) return a.account.provider === 's3' ? -1 : 1
      if (a.availableBytes === null) return a.account.provider === 's3' ? -1 : 1
      if (b.availableBytes === null) return b.account.provider === 's3' ? 1 : -1
      return Number(b.availableBytes - a.availableBytes)
    })[0]?.account ?? null

  // Smart Auto: largest free headroom among drives below the safety cap. When
  // every fitting drive is at/over the cap, fall back to the drive with the
  // most free bytes so the guard alone never hard-fails an upload.
  const chooseAuto = () => {
    const safe = eligible.filter(underSafetyCap)
    return pickMostFree(safe.length > 0 ? safe : eligible)
  }

  if (mode === 'priority') {
    // Priority Waterfall: first account in the stored order that fits the file
    // AND is below the safety cap; when the whole waterfall is capped, fall
    // back to Smart Auto instead of choking a drive.
    const firstSafe = byPriority(eligible, priorityOrder).find(underSafetyCap)
    if (firstSafe) return firstSafe.account
    return chooseAuto()
  }

  if (mode === 'rules') {
    // Rule-Based: video/* -> assigned video pool, everything else -> primary
    // pool. A missing/full/capped target falls back to Smart Auto.
    const isVideo = typeof mimeType === 'string' && mimeType.toLowerCase().startsWith('video/')
    const targetId = isVideo ? (typeRules.video ?? typeRules.default) : (typeRules.default ?? typeRules.document)
    if (targetId) {
      const target = eligible.find((candidate) => candidate.account.id === targetId)
      if (target && underSafetyCap(target)) return target.account
    }
    return chooseAuto()
  }

  return chooseAuto()
}

export async function handleUpload(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    logUpload('request started', { userId: req.user!.id, contentLength: req.headers['content-length'] })
    const contentType = req.headers['content-type']
    if (!contentType?.includes('multipart/form-data')) return res.status(400).json({ code: 'UPLOAD_INVALID_CONTENT_TYPE', message: 'multipart/form-data required.' })

    // Pre-flight: refuse the request before any stream is consumed when the user
    // has no connected storage account — previously this fell through into upload
    // planning and surfaced as an opaque backend failure.
    const activeAccountCount = await prisma.connectedAccount.count({
      where: { userId: req.user!.id, provider: { in: ['google_drive', 's3'] }, status: 'connected' },
    })
    if (activeAccountCount === 0) {
      return res.status(400).json({
        success: false,
        code: 'NO_ACTIVE_STORAGE_ACCOUNT',
        message: 'No active storage accounts found. Please connect a storage account first.',
      })
    }

    const busboy = Busboy({ headers: req.headers, limits: { files: 25, fileSize: env.MAX_UPLOAD_BYTES } })
    const fields: { sizeBytes?: bigint; fileName?: string; mimeType?: string; folderId?: string } = {}
    let batchMeta: UploadMeta[] | null = null
    let metaParseFailed = false
    let responded = false
    let fileSeen = false
    const reservedBytesByAccount = new Map<string, bigint>()
    const completed: Array<Record<string, unknown>> = []
    const failed: Array<{ fileName: string; code: string; message: string }> = []
    const pendingUploads: Array<Promise<void>> = []
    const vaultAccountIds = new Set<string>()

    const fail = async (status: number, code: string, message: string) => {
      if (responded) return
      responded = true
      req.unpipe(busboy)
      req.resume()
      return res.status(status).json({ code, message })
    }

    const parseBatchMeta = (value: string) => JSON.parse(value).map((item: { fieldName: string; fileName: string; mimeType: string; sizeBytes: string | number; folderId?: string }) => ({
      fieldName: item.fieldName,
      fileName: item.fileName,
      mimeType: item.mimeType,
      sizeBytes: BigInt(item.sizeBytes),
      folderId: item.folderId,
    })) as UploadMeta[]

    const metaForFile = (fieldName: string, info: { filename: string; mimeType: string }) => {
      if (batchMeta) return batchMeta.find((item) => item.fieldName === fieldName)
      const sizeBytes = fields.sizeBytes
      if (!sizeBytes) return null
      return { fieldName, sizeBytes, fileName: fields.fileName || info.filename, mimeType: fields.mimeType || info.mimeType || 'application/octet-stream', folderId: fields.folderId }
    }

    const uploadOne = async (fieldName: string, fileStream: NodeJS.ReadableStream, info: { filename: string; mimeType: string }) => {
      const meta = metaForFile(fieldName, info)
      const fileName = meta?.fileName || info.filename
      try {
        fileStream.on('limit', () => logUpload('file stream size limit reached', { fileName }))
        if (!meta?.sizeBytes || meta.sizeBytes <= 0n) {
          fileStream.resume()
          failed.push({ fileName, code: 'UPLOAD_SIZE_REQUIRED', message: 'sizeBytes field must be sent before file field.' })
          return
        }
        if (meta.sizeBytes > BigInt(env.MAX_UPLOAD_BYTES)) {
          fileStream.resume()
          failed.push({ fileName, code: 'UPLOAD_TOO_LARGE', message: 'File exceeds max upload size.' })
          return
        }

        const folderId = meta.folderId || null
        let targetAccountId: string | undefined = undefined
        if (folderId) {
          const folderRecord = await prisma.folder.findFirstOrThrow({ where: { id: folderId, userId: req.user!.id, deletedAt: null } })
          if (folderRecord.connectedAccountId) {
            targetAccountId = folderRecord.connectedAccountId
          }
        }

        // Step 3: quota-aware vault routing. Files that fit on one account keep the
        // classic single-object path below; oversized files are split into 500 MB–1 GB
        // parts across accounts and streamed straight into resumable uploads.
        const vaultPlan = await planUpload(req.user!.id, meta.sizeBytes, reservedBytesByAccount, targetAccountId)
        if (vaultPlan.kind === 'impossible') {
          fileStream.resume()
          failed.push({ fileName, code: 'NOT_ENOUGH_STORAGE', message: 'Combined connected storage is smaller than this upload.' })
          return
        }
        if (vaultPlan.kind === 'chunked') {
          logUpload('chunked vault upload started', { fileName, sizeBytes: meta.sizeBytes.toString(), chunks: vaultPlan.chunks.length })
          const result = await uploadChunkedFile({
            userId: req.user!.id,
            source: fileStream as unknown as Readable,
            plan: vaultPlan,
            name: fileName,
            mimeType: meta.mimeType,
            sizeBytes: meta.sizeBytes,
            folderId,
            reservedBytesByAccount,
            log: logUpload,
          })
          for (const chunk of vaultPlan.chunks) vaultAccountIds.add(chunk.account.id)
          completed.push({
            id: result.file.id,
            name: result.file.name,
            mimeType: result.file.mimeType,
            sizeBytes: result.file.sizeBytes.toString(),
            folderId: result.file.folderId,
            connectedAccountId: result.file.connectedAccountId,
            provider: 'vault',
            chunked: true,
            chunks: result.chunkCount,
          })
          await createAuditLog(req.user!.id, 'UPLOAD_FILE', 'file', result.file.id, { name: result.file.name, size: result.file.sizeBytes.toString(), chunked: true })
          logUpload('chunked vault upload completed', { fileName, chunks: result.chunkCount })
          return
        }

        const account = await selectAccount(req.user!.id, meta.sizeBytes, reservedBytesByAccount, targetAccountId, meta.mimeType)
        if (!account) {
          fileStream.resume()
          failed.push({ fileName, code: 'NO_ACCOUNT_WITH_ENOUGH_SPACE', message: 'No connected storage account has enough space for this upload.' })
          return
        }
        reservedBytesByAccount.set(account.id, (reservedBytesByAccount.get(account.id) ?? 0n) + meta.sizeBytes)

        const session = await prisma.uploadSession.create({ data: { userId: req.user!.id, targetConnectedAccountId: account.id, folderId, fileName, mimeType: meta.mimeType, sizeBytes: meta.sizeBytes, status: 'uploading' } })
        logUpload('file upload started', { sessionId: session.id, accountId: account.id, fileName, sizeBytes: meta.sizeBytes.toString() })
        const chunks: Buffer[] = []
        fileStream.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
        })
        await new Promise<void>((resolve, reject) => {
          fileStream.on('end', resolve)
          fileStream.on('error', reject)
        })
        const fileBuffer = Buffer.concat(chunks)
        const streamedBytes = BigInt(fileBuffer.length)

        let providerFileId = ''
        let s3FileId: string | null = null
        let uploadedName = fileName
        let uploadedMimeType = meta.mimeType
        let uploadedThumbnailUrl: string | null = null
        if (account.provider === 's3') {
          const config = await getS3ConfigForAccount(account.id, req.user!.id)
          const provisionalFile = await prisma.file.create({
            data: { userId: req.user!.id, connectedAccountId: account.id, folderId, provider: 's3', providerFileId: 'pending', name: fileName, mimeType: meta.mimeType, sizeBytes: meta.sizeBytes, status: 'uploading' },
          })
          s3FileId = provisionalFile.id
          providerFileId = buildS3ObjectKey(config, req.user!.id, provisionalFile.id, fileName)
          await uploadS3Object(config, providerFileId, Readable.from(fileBuffer), meta.mimeType)
          await prisma.file.update({ where: { id: provisionalFile.id }, data: { providerFileId, status: 'active' } })
          completed.push({ ...provisionalFile, providerFileId, status: 'active', sizeBytes: provisionalFile.sizeBytes.toString() })
          await trackWholeFile(req.user!.id, provisionalFile, meta.mimeType, account.email, providerFileId)
          logUpload('s3 upload completed', { sessionId: session.id, accountId: account.id, fileName })
        } else {
          const auth = await getAuthedGoogleClient(account)
          const drive = google.drive({ version: 'v3', auth })
          const appFolderId = await ensureGoogleAppFolder(account)
          let targetParentId = appFolderId
          if (folderId) {
            const folderRecord = await prisma.folder.findFirst({ where: { id: folderId, userId: req.user!.id } })
            if (folderRecord?.providerFolderId) {
              targetParentId = folderRecord.providerFolderId
            }
          }
          const uploaded = await drive.files.create({
            requestBody: { name: fileName, parents: [targetParentId] },
            media: { mimeType: meta.mimeType, body: Readable.from(fileBuffer) },
            fields: 'id,name,mimeType,size,thumbnailLink',
          })
          providerFileId = uploaded.data.id ?? ''
          uploadedName = uploaded.data.name ?? fileName
          uploadedMimeType = uploaded.data.mimeType ?? meta.mimeType
          uploadedThumbnailUrl = uploaded.data.thumbnailLink ?? null
          logUpload('google upload completed', { sessionId: session.id, accountId: account.id, fileName })

          // Make the file public (anyone with link can edit/download)
          try {
            await drive.permissions.create({
              fileId: providerFileId,
              requestBody: {
                role: 'writer',
                type: 'anyone'
              }
            })
            logUpload('google file permissions set to public writer', { sessionId: session.id, providerFileId })
          } catch (err: any) {
            console.error('Failed to make Google Drive file public:', err.message || err)
          }
        }

        if (streamedBytes !== meta.sizeBytes) {
          if (s3FileId) await prisma.file.update({ where: { id: s3FileId }, data: { status: 'deleted', deletedAt: new Date() } }).catch(() => undefined)
          await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'failed', errorMessage: 'Streamed byte count did not match declared size.' } })
          failed.push({ fileName, code: 'UPLOAD_SIZE_MISMATCH', message: 'Streamed byte count did not match declared size.' })
          return
        }

        const file = account.provider === 's3' ? null : await prisma.file.create({ data: { userId: req.user!.id, connectedAccountId: account.id, folderId, provider: 'google_drive', providerFileId, name: uploadedName, mimeType: uploadedMimeType, sizeBytes: meta.sizeBytes, thumbnailUrl: uploadedThumbnailUrl } })
        if (file) {
          logUpload('database file created', { sessionId: session.id, fileId: file.id, accountId: account.id })
          completed.push({ ...file, sizeBytes: file.sizeBytes.toString() })
          await trackWholeFile(req.user!.id, file, uploadedMimeType, account.email, providerFileId)
        }
        await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'completed', completedAt: new Date() } })
        if (account.provider === 's3') syncS3Quota(account.id).catch(() => undefined)
        else syncQuotaInBackground(account.id, session.id)
      } catch (error) {
        fileStream.resume()
        logUpload('file upload failed', { fileName, message: error instanceof Error ? error.message : 'Upload failed' })
        failed.push({ fileName, code: 'UPLOAD_FAILED', message: error instanceof Error ? error.message : 'Upload failed' })
      }
    }

    busboy.on('field', (name, value) => {
      try {
        if (name === 'sizeBytes') fields.sizeBytes = BigInt(value)
        if (name === 'fileName') fields.fileName = value
        if (name === 'mimeType') fields.mimeType = value
        if (name === 'folderId') fields.folderId = value
        if (name === 'filesMeta') batchMeta = parseBatchMeta(value)
      } catch (error) {
        // Malformed metadata must produce a clean 400 — never an uncaught throw
        // inside a stream handler (which would kill the connection mid-upload).
        metaParseFailed = true
        logUpload('invalid upload metadata field', { field: name, message: error instanceof Error ? error.message : 'Unknown error' })
      }
    })

    busboy.on('file', (name, fileStream, info) => {
      fileSeen = true
      // A stream-level 'error' event with no listener crashes the process; log it
      // so the response can fail gracefully instead of dropping the socket.
      fileStream.on('error', (error) => {
        logUpload('file stream error', { fileName: info.filename, message: error instanceof Error ? error.message : 'Unknown stream error' })
      })
      // Catch uploadOne rejections the moment they happen: a rejection left
      // unhandled until busboy 'finish' triggers Node's unhandledRejection
      // default (process exit) and the browser reports NetworkError.
      pendingUploads.push(
        uploadOne(name, fileStream, info).catch((error) => {
          logUpload('file upload threw', { fileName: info.filename, message: error instanceof Error ? error.message : 'Upload failed' })
          failed.push({ fileName: info.filename, code: 'UPLOAD_FAILED', message: error instanceof Error ? error.message : 'Upload failed' })
          fileStream.resume()
        }),
      )
    })

    busboy.on('error', (error) => {
      logUpload('multipart parser failed', { message: error instanceof Error ? error.message : 'Unknown error' })
      if (!responded) {
        responded = true
        next(error)
      }
    })

    busboy.on('finish', () => {
      if (!responded && metaParseFailed) return fail(400, 'UPLOAD_META_INVALID', 'Upload metadata must be valid JSON with numeric sizes.')
      if (!responded && !fileSeen) return fail(400, 'UPLOAD_FILE_REQUIRED', 'file field required.')
      Promise.all(pendingUploads).then(() => {
        if (responded) return
        for (const accountId of vaultAccountIds) syncQuotaInBackground(accountId, 'vault-batch')
        responded = true
        logUpload('response sent', { completed: completed.length, failed: failed.length })
        if (completed.length === 0) return res.status(400).json({ code: failed[0]?.code ?? 'UPLOAD_FAILED', message: failed[0]?.message ?? 'Upload failed', failed })
        if (!batchMeta && completed.length === 1 && failed.length === 0) return res.status(201).json({ file: completed[0] })
        return res.status(201).json({ files: completed, failed })
      }).catch(next)
    })

    req.pipe(busboy)
  } catch (error) {
    return next(error)
  }
}

uploadRouter.post('/', requireAuth, handleUpload)

// Resumable upload endpoints

// 1. Initialize resumable session
uploadRouter.post('/resumable/init', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({
      fileName: z.string().min(1),
      mimeType: z.string().min(1),
      sizeBytes: z.string(),
      folderId: z.string().nullable().optional(),
      targetAccountId: z.string().nullable().optional()
    }).parse(req.body)

    const sizeBytes = BigInt(body.sizeBytes)
    if (sizeBytes <= 0n) return res.status(400).json({ code: 'UPLOAD_SIZE_REQUIRED', message: 'Valid sizeBytes required.' })
    if (sizeBytes > BigInt(env.MAX_UPLOAD_BYTES)) return res.status(400).json({ code: 'UPLOAD_TOO_LARGE', message: 'File exceeds max upload size.' })

    const folderId = body.folderId || null
    let targetAccountId = body.targetAccountId
    if (folderId) {
      const folderRecord = await prisma.folder.findFirstOrThrow({ where: { id: folderId, userId: req.user!.id, deletedAt: null } })
      if (folderRecord.connectedAccountId) {
        targetAccountId = folderRecord.connectedAccountId
      }
    }

    const account = await selectAccount(req.user!.id, sizeBytes, undefined, targetAccountId, body.mimeType)
    if (!account) return res.status(400).json({ code: 'NO_ACCOUNT_WITH_ENOUGH_SPACE', message: 'No connected storage account has enough space.' })

    if (account.provider !== 'google_drive') {
      const session = await prisma.uploadSession.create({
        data: {
          userId: req.user!.id,
          targetConnectedAccountId: account.id,
          folderId,
          fileName: body.fileName,
          mimeType: body.mimeType,
          sizeBytes,
          status: 'uploading'
        }
      })
      return res.status(201).json({ sessionId: session.id, provider: account.provider, offset: 0 })
    }

    const auth = await getAuthedGoogleClient(account)
    const appFolderId = await ensureGoogleAppFolder(account)
    let targetParentId = appFolderId
    if (folderId) {
      const folderRecord = await prisma.folder.findFirst({ where: { id: folderId, userId: req.user!.id } })
      if (folderRecord?.providerFolderId) {
        targetParentId = folderRecord.providerFolderId
      }
    }

    // Initiate Google Drive Resumable Session
    const headers = new Headers()
    const token = await auth.getAccessToken()
    headers.set('Authorization', `Bearer ${token.token}`)
    headers.set('Content-Type', 'application/json')
    headers.set('X-Upload-Content-Type', body.mimeType)
    headers.set('X-Upload-Content-Length', sizeBytes.toString())

    const initRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: body.fileName,
        parents: [targetParentId]
      })
    })

    if (!initRes.ok) {
      const errText = await initRes.text()
      throw new Error(`Google API Init Error: ${errText}`)
    }

    const sessionUri = initRes.headers.get('location')
    if (!sessionUri) throw new Error('Google API did not return Location header.')

    const session = await prisma.uploadSession.create({
      data: {
        userId: req.user!.id,
        targetConnectedAccountId: account.id,
        folderId,
        fileName: body.fileName,
        mimeType: body.mimeType,
        sizeBytes,
        status: 'uploading',
        googleSessionUri: sessionUri
      }
    })

    return res.status(201).json({ sessionId: session.id, provider: 'google_drive', providerEmail: account.email, offset: 0 })
  } catch (error) {
    return next(error)
  }
})

// 2. Query/Resume resumable status
uploadRouter.get('/resumable/status/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const session = await prisma.uploadSession.findFirstOrThrow({
      where: { id: String(req.params.id), userId: req.user!.id }
    })

    if (session.status === 'completed') {
      return res.json({ status: 'completed', offset: session.sizeBytes.toString() })
    }

    if (!session.googleSessionUri || !session.targetConnectedAccountId) {
      return res.json({ status: 'uploading', offset: '0' })
    }

    const account = await prisma.connectedAccount.findFirstOrThrow({
      where: { id: session.targetConnectedAccountId, userId: req.user!.id }
    })
    const auth = await getAuthedGoogleClient(account)
    const token = await auth.getAccessToken()

    // Query Google Drive for uploaded offset
    const queryHeaders = new Headers()
    queryHeaders.set('Authorization', `Bearer ${token.token}`)
    queryHeaders.set('Content-Range', `bytes */${session.sizeBytes}`)

    const queryRes = await fetch(session.googleSessionUri, {
      method: 'PUT',
      headers: queryHeaders
    })

    if (queryRes.status === 308) {
      const range = queryRes.headers.get('range')
      if (range) {
        // e.g. bytes=0-1048575
        const parts = range.split('-')
        const lastByte = BigInt(parts[1])
        return res.json({ status: 'uploading', offset: (lastByte + 1n).toString() })
      }
    } else if (queryRes.ok) {
      return res.json({ status: 'completed', offset: session.sizeBytes.toString() })
    }

    return res.json({ status: 'uploading', offset: '0' })
  } catch (error) {
    return res.json({ status: 'failed', offset: '0' })
  }
})

// 3. Upload chunk
uploadRouter.put('/resumable/chunk/:id', requireAuth, async (req: AuthRequest, res, next) => {
  // Declared before try so the catch can detect a client disconnect that aborts
  // the downstream Google fetch (undici throws `TypeError: terminated`).
  let clientAborted = false
  const abortController = new AbortController()
  try {
    const session = await prisma.uploadSession.findFirstOrThrow({
      where: { id: String(req.params.id), userId: req.user!.id }
    })

    const rangeHeader = req.headers['content-range']
    if (!rangeHeader || typeof rangeHeader !== 'string') {
      return res.status(400).json({ code: 'MISSING_CONTENT_RANGE', message: 'Content-Range header is required.' })
    }

    // Parse Content-Range, e.g. bytes 0-5242879/10485760
    const match = rangeHeader.match(/bytes\s+(\d+)-(\d+)\/(\d+)/)
    if (!match) return res.status(400).json({ code: 'INVALID_CONTENT_RANGE', message: 'Invalid Content-Range format.' })

    const startByte = BigInt(match[1])
    const endByte = BigInt(match[2])
    const totalBytes = BigInt(match[3])

    if (!session.googleSessionUri || !session.targetConnectedAccountId) {
      return res.status(400).json({ code: 'UNSUPPORTED_PROVIDER', message: 'Only Google Drive resumable uploads supported.' })
    }

    const account = await prisma.connectedAccount.findFirstOrThrow({
      where: { id: session.targetConnectedAccountId, userId: req.user!.id }
    })
    const auth = await getAuthedGoogleClient(account)
    const drive = google.drive({ version: 'v3', auth })
    const token = await auth.getAccessToken()

    // Track client disconnects so an aborted upload releases cleanly instead of
    // throwing undici's `TypeError: terminated` (which currently surfaces as an
    // uncaught error stack). When the browser cancels mid-PUT, `req` emits
    // 'aborted'/'close' and the downstream Google fetch is aborted.
    const onClientAbort = () => {
      clientAborted = true
      abortController.abort()
    }
    req.once('aborted', onClientAbort)
    req.once('close', () => { if (!res.writableEnded) onClientAbort() })

    // Stream chunk body from client to Google Drive resumable URI
    const putHeaders = new Headers()
    putHeaders.set('Authorization', `Bearer ${token.token}`)
    putHeaders.set('Content-Range', rangeHeader)
    putHeaders.set('Content-Length', (endByte - startByte + 1n).toString())

    const putRes = await fetch(session.googleSessionUri, {
      method: 'PUT',
      headers: putHeaders,
      body: req as any,
      signal: abortController.signal,
      duplex: 'half'
    } as any)

    // If the client went away, the response is already gone — release quietly.
    if (clientAborted || res.writableEnded || res.destroyed) return

    if (putRes.status === 308) {
      return res.json({ status: 'uploading', offset: (endByte + 1n).toString() })
    }

    if (putRes.ok) {
      // Completed! Parse metadata
      const fileMeta = await putRes.json() as { id: string; name: string; mimeType: string }

      // Make the file public (anyone with link can edit/download)
      try {
        await drive.permissions.create({
          fileId: fileMeta.id,
          requestBody: {
            role: 'writer',
            type: 'anyone'
          }
        })
      } catch (err: any) {
        console.error('Failed to make Google Drive resumable file public:', err.message || err)
      }

      let existingFile = await prisma.file.findFirst({
        where: { providerFileId: fileMeta.id, userId: req.user!.id }
      })

      if (!existingFile) {
        existingFile = await prisma.file.create({
          data: {
            userId: req.user!.id,
            connectedAccountId: account.id,
            folderId: session.folderId,
            provider: 'google_drive',
            providerFileId: fileMeta.id,
            name: fileMeta.name || session.fileName,
            mimeType: fileMeta.mimeType || session.mimeType,
            sizeBytes: totalBytes
          }
        })
      }

      await prisma.uploadSession.update({
        where: { id: session.id },
        data: { status: 'completed', completedAt: new Date() }
      })

      await createAuditLog(req.user!.id, 'UPLOAD_FILE', 'file', existingFile.id, { name: existingFile.name, size: existingFile.sizeBytes.toString() })

      syncQuotaInBackground(account.id, session.id)

      return res.status(201).json({ status: 'completed', file: { ...existingFile, sizeBytes: existingFile.sizeBytes.toString() } })
    }

    const rawError = await putRes.text()
    // Google answers with JSON { error: { message } } — surface the human
    // message so the frontend drawer shows a clean error instead of raw JSON.
    let errorMsg = rawError
    try {
      const parsed = JSON.parse(rawError) as { error?: { message?: string }; message?: string }
      errorMsg = parsed?.error?.message || parsed?.message || rawError
    } catch { /* non-JSON body (proxy/HTML) — keep the raw text */ }
    await prisma.uploadSession.update({
      where: { id: session.id },
      data: { status: 'failed', errorMessage: errorMsg }
    })

    return res.status(putRes.status).json({ code: 'UPLOAD_FAILED', message: errorMsg || `Google Drive upload failed (HTTP ${putRes.status}).` })
  } catch (error) {
    // Client disconnect surfaces as undici `TypeError: terminated` / AbortError.
    // The response is already gone, so do not forward to the error middleware
    // (which would log an uncaught stack). Just release the socket.
    if (clientAborted || isClientAbortError(error)) return
    return next(error)
  }
})
