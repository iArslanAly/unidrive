import { PassThrough, type Readable, type Writable } from 'node:stream'
import { once } from 'node:events'
import crypto from 'node:crypto'
import type { ConnectedAccount, File, VirtualFile } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { ensureGoogleAppFolder, getAuthedGoogleClient } from '../google/google.service.js'

/** Sequential parts are kept between 500 MB and 1 GB per the vault chunking policy. */
export const CHUNK_MIN_BYTES = 500n * 1024n * 1024n
export const CHUNK_MAX_BYTES = 1024n * 1024n * 1024n

export type AccountCandidate = {
  id: string
  email: string
  provider: string
  /** Remaining free bytes after in-flight reservations; null means "unlimited / unknown". */
  freeBytes: bigint | null
}

export type PlannedChunk = {
  account: AccountCandidate
  chunkIndex: number
  offset: bigint
  size: bigint
}

export type UploadPlan =
  | { kind: 'single'; account: AccountCandidate }
  | { kind: 'chunked'; chunks: PlannedChunk[] }
  | { kind: 'impossible' }

/**
 * Builds free-space candidates for a user, subtracting bytes already reserved by
 * concurrent uploads in the same request batch.
 */
async function loadCandidates(userId: string, reservedBytesByAccount: Map<string, bigint>, targetAccountId?: string | null): Promise<AccountCandidate[]> {
  const accounts = await prisma.connectedAccount.findMany({
    where: { userId, provider: { in: ['google_drive', 's3'] }, status: 'connected', ...(targetAccountId ? { id: targetAccountId } : {}) },
    include: { storageAccount: true },
  })
  return accounts.map((account) => {
    const quotaAvailable = account.storageAccount?.availableBytes
    const allocatedFallback =
      account.allocatedSpace !== null && account.allocatedSpace !== undefined ? account.allocatedSpace - account.usedSpace : null
    const available = quotaAvailable ?? allocatedFallback
    const reserved = reservedBytesByAccount.get(account.id) ?? 0n
    const freeBytes = available === null || available === undefined ? null : available - reserved
    return { id: account.id, email: account.email, provider: account.provider, freeBytes }
  })
}

/**
 * Quota-aware routing:
 * - a file that fits on one account stays a single standard file;
 * - otherwise the byte range is split into 500 MB–1 GB sequential parts and
 *   dispatched across accounts by their free space;
 * - returns 'impossible' when combined free space is still too small.
 */
export async function planUpload(userId: string, sizeBytes: bigint, reservedBytesByAccount: Map<string, bigint> = new Map(), targetAccountId?: string | null): Promise<UploadPlan> {
  const candidates = await loadCandidates(userId, reservedBytesByAccount, targetAccountId)
  if (candidates.length === 0) return { kind: 'impossible' }

  const canFitWhole = (account: AccountCandidate) => account.freeBytes === null || account.freeBytes >= sizeBytes
  const single = [...candidates].sort((a, b) => {
    if (a.freeBytes === null || b.freeBytes === null) {
      if (a.freeBytes === null && b.freeBytes === null) return a.provider === 's3' ? -1 : 1
      return a.freeBytes === null ? (a.provider === 's3' ? -1 : 1) : (b.provider === 's3' ? 1 : -1)
    }
    return Number(b.freeBytes - a.freeBytes)
  }).find(canFitWhole)
  if (single) return { kind: 'single', account: single }

  const totalFree = candidates.reduce((sum, account) => sum + (account.freeBytes ?? 0n), 0n)
  if (totalFree < sizeBytes) return { kind: 'impossible' }

  // Greedy sequential split: always take from the account with the most free space,
  // clamping each part to [CHUNK_MIN, CHUNK_MAX] where possible.
  const pool = candidates
    .filter((account) => account.freeBytes !== null && account.freeBytes > 0n)
    .map((account) => ({ ...account, freeBytes: account.freeBytes as bigint }))
  const chunks: PlannedChunk[] = []
  let remaining = sizeBytes
  let offset = 0n
  while (remaining > 0n) {
    if (pool.length === 0) return { kind: 'impossible' }
    pool.sort((a, b) => Number(b.freeBytes - a.freeBytes))
    const wanted = CHUNK_MIN_BYTES < remaining ? CHUNK_MIN_BYTES : remaining
    const pickIndex = pool.findIndex((account) => account.freeBytes >= wanted)
    const target = pool[pickIndex >= 0 ? pickIndex : 0]
    const desired = [remaining, CHUNK_MAX_BYTES, target.freeBytes].reduce((a, b) => (a < b ? a : b))
    if (desired <= 0n) return { kind: 'impossible' }
    chunks.push({ account: { id: target.id, email: target.email, provider: target.provider, freeBytes: target.freeBytes }, chunkIndex: chunks.length, offset, size: desired })
    target.freeBytes -= desired
    offset += desired
    remaining -= desired
    if (target.freeBytes <= 0n) pool.splice(pool.indexOf(target), 1)
  }
  return { kind: 'chunked', chunks }
}

/** Reads bytes from a shared async source, keeping any unread tail pushed back for the next chunk. */
class VaultSourceReader {
  private iterator: AsyncIterator<Buffer>
  private leftover: Buffer | null = null

  constructor(source: Readable) {
    this.iterator = source[Symbol.asyncIterator]() as AsyncIterator<Buffer>
  }

  /** Returns up to exactly `size` bytes; null only when the source is fully consumed. */
  async read(size: bigint): Promise<Buffer | null> {
    const parts: Buffer[] = []
    let got = 0n
    if (this.leftover) {
      const take = this.leftover.length <= Number(size) ? this.leftover.length : Number(size)
      parts.push(this.leftover.subarray(0, take))
      this.leftover = this.leftover.length > take ? this.leftover.subarray(take) : null
      got += BigInt(take)
    }
    while (got < size) {
      const { value, done } = await this.iterator.next()
      if (done) break
      const buf = Buffer.isBuffer(value) ? value : Buffer.from(value as unknown as ArrayBufferLike)
      if (buf.length === 0) continue
      const need = Number(size - got)
      if (buf.length > need) {
        parts.push(buf.subarray(0, need))
        this.leftover = buf.subarray(need)
        got += BigInt(need)
      } else {
        parts.push(buf)
        got += BigInt(buf.length)
      }
    }
    if (got === 0n) return null
    return parts.length === 1 ? parts[0] : Buffer.concat(parts)
  }
}

async function writeWithBackpressure(sink: Writable, chunk: Buffer): Promise<void> {
  if (!sink.write(chunk)) await once(sink, 'drain')
}

/**
 * Streams one planned chunk straight into Google Drive through a resumable
 * session so multi-gigabyte parts never sit in RAM or on disk.
 */
async function uploadChunkToGoogle(account: AccountCandidate, body: Readable, contentLength: bigint, name: string, mimeType: string): Promise<string> {
  const connected: ConnectedAccount = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: account.id } })
  const auth = await getAuthedGoogleClient(connected)
  const token = await auth.getAccessToken()
  const parentFolderId = await ensureGoogleAppFolder(connected)

  const initResponse = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.token ?? ''}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': contentLength.toString(),
    },
    body: JSON.stringify({ name, parents: [parentFolderId] }),
  })
  if (!initResponse.ok) throw new Error(`Google resumable session failed (${initResponse.status}): ${await initResponse.text().catch(() => initResponse.statusText)}`)
  const sessionUri = initResponse.headers.get('location')
  if (!sessionUri) throw new Error('Google resumable session URI missing.')

  const putResponse = await fetch(sessionUri, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token.token ?? ''}`,
      'Content-Type': mimeType,
      'Content-Length': contentLength.toString(),
      'Content-Range': `bytes 0-${contentLength > 0n ? (contentLength - 1n).toString() : '0'}/${contentLength.toString()}`,
    },
    body: body as unknown as BodyInit,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
  if (!putResponse.ok && putResponse.status !== 308) {
    throw new Error(`Google chunk upload failed (${putResponse.status}): ${await putResponse.text().catch(() => putResponse.statusText)}`)
  }
  const created = (await putResponse.json().catch(() => ({}))) as { id?: string }
  if (!created.id) throw new Error('Google chunk upload returned no file id.')
  return created.id
}

/** Resolves a stable virtual path such as `/Lectures/Week 1/intro.mp4`. */
export async function resolveVirtualPath(userId: string, folderId: string | null, name: string): Promise<string> {
  const segments: string[] = [name]
  let cursor = folderId
  let depth = 0
  while (cursor && depth < 32) {
    const folder = await prisma.folder.findFirst({ where: { id: cursor, userId }, select: { name: true, parentId: true } })
    if (!folder) break
    segments.unshift(folder.name)
    cursor = folder.parentId
    depth += 1
  }
  return `/${segments.join('/')}`
}

/** Records a whole (non-chunked) file as a VirtualFile with a single covering chunk. */
export async function recordWholeFile(params: {
  userId: string
  fileId: string
  name: string
  virtualPath: string
  totalSize: bigint
  mimeType: string
  providerEmail: string
  remoteFileId: string
}): Promise<VirtualFile> {
  // Idempotency: re-uploads tied to the same File row must not duplicate vault rows.
  const existing = await prisma.virtualFile.findFirst({ where: { fileId: params.fileId } })
  if (existing) return existing
  const virtualFile = await prisma.virtualFile.create({
    data: {
      userId: params.userId,
      fileId: params.fileId,
      name: params.name,
      virtualPath: params.virtualPath,
      totalSize: params.totalSize,
      mimeType: params.mimeType,
      isChunked: false,
      status: 'active',
    },
  })
  await prisma.fileChunk.create({
    data: { fileId: virtualFile.id, chunkIndex: 0, size: params.totalSize, providerEmail: params.providerEmail, remoteFileId: params.remoteFileId },
  })
  return virtualFile
}



export type ChunkedUploadResult = { virtualFile: VirtualFile; file: File; chunkCount: number; firstAccountEmail: string }

/**
 * Dispatches an incoming request stream across multiple accounts: the source is
 * consumed exactly once, bytes are cut at planned chunk boundaries and streamed
 * straight into per-account resumable uploads (bounded memory only).
 */
export async function uploadChunkedFile(params: {
  userId: string
  source: Readable
  plan: Extract<UploadPlan, { kind: 'chunked' }>
  name: string
  mimeType: string
  sizeBytes: bigint
  folderId: string | null
  reservedBytesByAccount: Map<string, bigint>
  log?: (message: string, metadata?: Record<string, unknown>) => void
}): Promise<ChunkedUploadResult> {
  const { userId, source, plan, name, mimeType, sizeBytes, folderId } = params
  const virtualPath = await resolveVirtualPath(userId, folderId, name)

  const virtualFile = await prisma.virtualFile.create({
    data: { userId, name, virtualPath, totalSize: sizeBytes, mimeType, isChunked: true, status: 'uploading' },
  })
  const firstAccountId = plan.chunks[0]?.account.id
  if (!firstAccountId) throw new Error('Chunked upload plan has no chunks.')
  // A standard File row keeps chunked uploads visible to listings, shares, previews and trash.
  const fileRow = await prisma.file.create({
    data: { userId, connectedAccountId: firstAccountId, folderId, provider: 'vault', providerFileId: virtualFile.id, name, mimeType, sizeBytes },
  })
  await prisma.virtualFile.update({ where: { id: virtualFile.id }, data: { fileId: fileRow.id } })

  const reader = new VaultSourceReader(source)
  let partNumber = 0
  try {
    for (const chunk of plan.chunks) {
      partNumber += 1
      const partName = `${name}.vaultrz${String(partNumber).padStart(4, '0')}`
      params.log?.('vault chunk upload started', { virtualFileId: virtualFile.id, chunkIndex: chunk.chunkIndex, size: chunk.size.toString(), account: chunk.account.email })

      const sink = new PassThrough()
      // An 'error' event without a listener would crash the process; swallow it
      // here because the uploadPromise failure below carries the real reason.
      sink.on('error', () => undefined)
      const uploadPromise = uploadChunkToGoogle(chunk.account, sink, chunk.size, partName, mimeType)
      // Attach a rejection handler immediately: if the Google call fails while
      // the source is still being written, Node would otherwise register an
      // unhandled rejection (default: process exit) → dropped socket → the
      // browser surfaces "NetworkError when attempting to fetch resource."
      const settled = uploadPromise.then(
        () => null,
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
      )

      let remoteFileId: string
      try {
        const writePhase = (async () => {
          let written = 0n
          while (written < chunk.size) {
            const buf = await reader.read(chunk.size - written)
            if (!buf || buf.length === 0) throw new Error('Source stream ended before planned chunk boundary.')
            await writeWithBackpressure(sink, buf)
            written += BigInt(buf.length)
          }
          sink.end()
        })()
        // Fail fast when the provider rejects mid-write — otherwise backpressure
        // would wait forever on a sink nobody is draining.
        await Promise.race([
          writePhase,
          settled.then((error) => {
            if (error) throw error
            // Provider succeeded early: let writePhase decide when we move on.
            return new Promise<never>(() => undefined)
          }),
        ])
        remoteFileId = await uploadPromise
      } catch (error) {
        sink.destroy()
        throw error
      }

      await prisma.fileChunk.create({
        data: { fileId: virtualFile.id, chunkIndex: chunk.chunkIndex, size: chunk.size, providerEmail: chunk.account.email, remoteFileId },
      })
      await prisma.connectedAccount.update({ where: { id: chunk.account.id }, data: { usedSpace: { increment: chunk.size } } })
      params.reservedBytesByAccount.set(chunk.account.id, (params.reservedBytesByAccount.get(chunk.account.id) ?? 0n) + chunk.size)
      params.log?.('vault chunk upload completed', { virtualFileId: virtualFile.id, chunkIndex: chunk.chunkIndex, remoteFileId })
    }

    const updated = await prisma.virtualFile.update({ where: { id: virtualFile.id }, data: { status: 'active' } })
    return { virtualFile: updated, file: fileRow, chunkCount: plan.chunks.length, firstAccountEmail: plan.chunks[0]?.account.email ?? '' }
  } catch (error) {
    await prisma.virtualFile.update({ where: { id: virtualFile.id }, data: { status: 'failed' } }).catch(() => undefined)
    await prisma.file.update({ where: { id: fileRow.id }, data: { status: 'deleted', deletedAt: new Date() } }).catch(() => undefined)
    throw error
  }
}

/** AES-256-GCM encrypts a keyring value for storage inside `.vault_manifest.json`. */
export function encryptKeyringValue(value: string, vaultKey: Buffer): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', vaultKey, iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`
}

/** Reverses `encryptKeyringValue`; throws when the master key does not match. */
export function decryptKeyringValue(value: string, vaultKey: Buffer): string {
  const [ivRaw, tagRaw, dataRaw] = value.split(':')
  if (!ivRaw || !tagRaw || !dataRaw) throw new Error('Invalid keyring payload.')
  const decipher = crypto.createDecipheriv('aes-256-gcm', vaultKey, Buffer.from(ivRaw, 'base64'))
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(dataRaw, 'base64')), decipher.final()]).toString('utf8')
}
