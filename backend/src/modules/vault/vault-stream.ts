import type { ConnectedAccount, VirtualFile } from '@prisma/client'
import type { Response } from 'express'
import { once } from 'node:events'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { prisma } from '../../config/prisma.js'
import { getAuthedGoogleClient } from '../google/google.service.js'
import { createS3Client, getS3ConfigForAccount } from '../s3/s3.service.js'
import { normalizeHeaders } from '../files/stream-google-file.js'

export type ByteRange = { start: bigint; end: bigint }

/** Thrown when a Range header cannot be satisfied; mapped to HTTP 416 by routes. */
export class RangeNotSatisfiableError extends Error {
  constructor() {
    super('Requested range is not satisfiable.')
    this.name = 'RangeNotSatisfiableError'
  }
}

/**
 * Parses a HTTP Range header against a known total size.
 * Returns null when no (or malformed/unsatisfiable-ignored) range is requested,
 * meaning "stream the whole file". Throws RangeNotSatisfiableError for bad ranges.
 */
export function parseRangeHeader(header: string | undefined, totalSize: bigint): ByteRange | null {
  if (!header) return null
  const match = header.trim().match(/^bytes=(\d*)-(\d*)$/)
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null

  if (rawStart === '') {
    // Suffix range: last N bytes.
    const suffix = BigInt(rawEnd)
    if (suffix === 0n) throw new RangeNotSatisfiableError()
    const start = totalSize > suffix ? totalSize - suffix : 0n
    return { start, end: totalSize - 1n }
  }

  const start = BigInt(rawStart)
  if (start >= totalSize) throw new RangeNotSatisfiableError()
  const end = rawEnd === '' ? totalSize - 1n : BigInt(rawEnd)
  if (end < start) throw new RangeNotSatisfiableError()
  return { start, end: end > totalSize - 1n ? totalSize - 1n : end }
}

/** Canonical Google Drive webContentLink used for HTTP 302 direct-to-CDN streaming. */
export function googleDirectDownloadUrl(remoteFileId: string): string {
  return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(remoteFileId)}`
}

const googleWorkspaceMimePrefix = 'application/vnd.google-apps.'

export function isGoogleWorkspaceMimeType(mimeType: string): boolean {
  return mimeType.startsWith(googleWorkspaceMimePrefix)
}

/** Resolves the connected account that physically stores a chunk, by its email. */
export async function resolveChunkAccount(userId: string, providerEmail: string): Promise<ConnectedAccount | null> {
  return prisma.connectedAccount.findFirst({ where: { userId, email: providerEmail, status: 'connected' } })
}

type ChunkWithOffset = { chunkIndex: number; size: bigint; providerEmail: string; remoteFileId: string; offset: bigint }

/** Loads a VirtualFile with its ordered chunks and computed byte offsets. */
export async function loadVirtualFileWithChunks(userId: string, fileIdParam: string): Promise<{ virtualFile: VirtualFile; chunks: ChunkWithOffset[] } | null> {
  const virtualFile = await prisma.virtualFile.findFirst({
    where: { OR: [{ id: fileIdParam }, { fileId: fileIdParam }], userId, status: 'active' },
  })
  if (!virtualFile) return null
  const rows = await prisma.fileChunk.findMany({ where: { fileId: virtualFile.id }, orderBy: { chunkIndex: 'asc' } })
  const chunks: ChunkWithOffset[] = []
  let offset = 0n
  for (const row of rows) {
    chunks.push({ chunkIndex: row.chunkIndex, size: row.size, providerEmail: row.providerEmail, remoteFileId: row.remoteFileId, offset })
    offset += row.size
  }
  return { virtualFile, chunks }
}

/** Pumps an async byte source into the HTTP response with backpressure and abort support. */
async function pumpToResponse(source: AsyncIterable<Uint8Array>, res: Response, expectedBytes: bigint): Promise<void> {
  let written = 0n
  for await (const piece of source) {
    if (res.destroyed || res.writableEnded) throw new Error('Client closed the connection during vault streaming.')
    const buf = Buffer.from(piece.buffer, piece.byteOffset, piece.length)
    written += BigInt(buf.length)
    if (!res.write(buf)) {
      await Promise.race([once(res, 'drain'), once(res, 'close')])
      if (res.destroyed) throw new Error('Client closed the connection during vault streaming.')
    }
  }
  if (written !== expectedBytes) throw new Error(`Vault slice length mismatch: expected ${expectedBytes}, streamed ${written}.`)
}

/** Fetches a byte slice [localStart..localEnd] of one chunk from its physical provider. */
async function fetchChunkSlice(userId: string, chunk: ChunkWithOffset, localStart: bigint, localEnd: bigint): Promise<AsyncIterable<Uint8Array>> {
  const account = await resolveChunkAccount(userId, chunk.providerEmail)
  if (!account) throw new Error(`Storage account ${chunk.providerEmail} is no longer connected for chunk ${chunk.chunkIndex}.`)
  const needsRange = localStart > 0n || localEnd < chunk.size - 1n
  const rangeValue = `bytes=${localStart}-${localEnd}`

  if (account.provider === 's3') {
    const config = await getS3ConfigForAccount(account.id)
    const client = createS3Client(config)
    const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: chunk.remoteFileId, ...(needsRange ? { Range: rangeValue } : {}) }))
    return response.Body as unknown as AsyncIterable<Uint8Array>
  }

  const auth = await getAuthedGoogleClient(account)
  const headers = normalizeHeaders(await auth.getRequestHeaders())
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(chunk.remoteFileId)}?alt=media`, {
    headers: { ...headers, ...(needsRange ? { Range: rangeValue } : {}) },
  })
  if (!response.ok || !response.body) {
    const message = await response.text().catch(() => response.statusText)
    throw new Error(`Failed to fetch vault chunk ${chunk.chunkIndex} (${response.status}): ${message || response.statusText}`)
  }
  return response.body as unknown as AsyncIterable<Uint8Array>
}

function contentDispositionHeader(type: 'inline' | 'attachment', fileName: string): string {
  return `${type}; filename="${fileName.replaceAll('"', '')}"`
}

export type VaultStreamOptions = { disposition?: 'inline' | 'attachment'; allowRedirect?: boolean }


/**
 * Streams (or 302-redirects) a VirtualFile for the current user.
 *
 * - Intact single-chunk Google files with `allowRedirect` get a 302 to the Drive
 *   webContentLink so playback bypasses the local proxy entirely.
 * - Chunked files are assembled: only chunks overlapping the requested byte range
 *   are fetched (HTTP 206 when a valid `Range` header is present), enabling video
 *   seeking without buffering whole multi-gigabyte files locally.
 */
export async function streamVaultVirtualFile(
  userId: string,
  fileIdParam: string,
  rangeHeader: string | undefined,
  res: Response,
  options: VaultStreamOptions = {},
): Promise<unknown> {
  const loaded = await loadVirtualFileWithChunks(userId, fileIdParam)
  if (!loaded) return res.status(404).json({ code: 'VAULT_FILE_NOT_FOUND', message: 'Vault file not found.' })
  const { virtualFile, chunks } = loaded
  if (chunks.length === 0) return res.status(410).json({ code: 'VAULT_FILE_EMPTY', message: 'Vault file has no stored chunks.' })
  const totalSize = virtualFile.totalSize

  // Direct CDN redirect for intact files covered by a single provider object.
  if (!virtualFile.isChunked && chunks.length === 1 && options.allowRedirect && !isGoogleWorkspaceMimeType(virtualFile.mimeType)) {
    const account = await resolveChunkAccount(userId, chunks[0].providerEmail)
    if (!account) return res.status(502).json({ code: 'VAULT_ACCOUNT_MISSING', message: 'Storage account for this file is not connected.' })
    if (account.provider === 'google_drive') return res.redirect(302, googleDirectDownloadUrl(chunks[0].remoteFileId))
  }

  let range: ByteRange | null
  try {
    range = parseRangeHeader(rangeHeader, totalSize)
  } catch (error) {
    if (error instanceof RangeNotSatisfiableError) {
      res.setHeader('Content-Range', `bytes */${totalSize.toString()}`)
      return res.status(416).json({ code: 'RANGE_NOT_SATISFIABLE', message: 'Requested range is not satisfiable.' })
    }
    throw error
  }

  const start = range ? range.start : 0n
  const end = range ? range.end : totalSize - 1n
  const length = totalSize === 0n ? 0n : end - start + 1n
  const isPartial = range !== null

  const overlapping = chunks
    .map((chunk) => {
      const chunkEnd = chunk.offset + chunk.size - 1n
      if (chunk.offset > end || chunkEnd < start) return null
      const localStart = start > chunk.offset ? start - chunk.offset : 0n
      const localEnd = end < chunkEnd ? end - chunk.offset : chunk.size - 1n
      return { chunk, localStart, localEnd }
    })
    .filter((item): item is { chunk: ChunkWithOffset; localStart: bigint; localEnd: bigint } => item !== null)

  const accounts = new Map<string, ConnectedAccount>()
  for (const item of overlapping) {
    if (accounts.has(item.chunk.providerEmail)) continue
    const account = await resolveChunkAccount(userId, item.chunk.providerEmail)
    if (!account) return res.status(502).json({ code: 'VAULT_ACCOUNT_MISSING', message: `Storage account ${item.chunk.providerEmail} is not connected.` })
    accounts.set(item.chunk.providerEmail, account)
  }

  res.status(isPartial ? 206 : 200)
  res.setHeader('Content-Type', virtualFile.mimeType || 'application/octet-stream')
  res.setHeader('Content-Length', length.toString())
  res.setHeader('Accept-Ranges', 'bytes')
  if (isPartial) res.setHeader('Content-Range', `bytes ${start.toString()}-${end.toString()}/${totalSize.toString()}`)
  if (options.disposition) res.setHeader('Content-Disposition', contentDispositionHeader(options.disposition, virtualFile.name))

  if (length === 0n) return res.end()

  try {
    for (const item of overlapping) {
      const sliceLength = item.localEnd - item.localStart + 1n
      const slice = await fetchChunkSlice(userId, item.chunk, item.localStart, item.localEnd)
      await pumpToResponse(slice, res, sliceLength)
    }
    res.end()
  } catch (error) {
    if (!res.headersSent) {
      return res.status(502).json({ code: 'VAULT_STREAM_FAILED', message: error instanceof Error ? error.message : 'Vault stream failed.' })
    }
    res.destroy(error instanceof Error ? error : new Error('Vault stream failed.'))
  }
}

