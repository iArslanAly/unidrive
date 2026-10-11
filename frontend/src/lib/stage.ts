import type { FileItem } from '@/data/drive-data'

export type StageKind = 'video' | 'audio' | 'image' | 'document' | 'office' | 'zip'

const officeMimeTypes = new Set([
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])

const googleDocumentMimeTypes = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
])

/** Classifies a file for the Universal Stage (video/audio/image/pdf/office/zip). */
export function getStageKind(file?: Pick<FileItem, 'name' | 'mimeType'> | null): StageKind | null {
  if (!file) return null
  const mime = file.mimeType ?? ''
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('image/') || mime === 'application/vnd.google-apps.drawing') return 'image'
  if (mime === 'application/pdf' || googleDocumentMimeTypes.has(mime)) return 'document'
  if (officeMimeTypes.has(mime)) return 'office'
  if (mime === 'application/zip' || mime === 'application/x-zip-compressed' || mime === 'application/x-7z-compressed' || /\.zip$/i.test(file.name)) return 'zip'
  return null
}

export function isSubtitleName(name: string): boolean {
  return /\.(srt|vtt)$/i.test(name)
}

export function subtitleTrackType(name: string): string {
  return /\.vtt$/i.test(name) ? 'text/vtt' : 'application/x-subrip'
}

/** Converts SubRip (`.srt`) cue text into a WebVTT document browsers can render as a track. */
export function srtToVtt(srt: string): string {
  const normalized = srt.replace(/^\uFEFF/, '').replace(/\r+/g, '')
  const blocks = normalized.trim().split(/\n\s*\n/)
  const cues: string[] = []
  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim().length > 0)
    const timingIndex = lines.findIndex((line) => line.includes('-->'))
    if (timingIndex === -1) continue
    const timing = lines[timingIndex].replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    const text = lines.slice(timingIndex + 1).join('\n')
    cues.push(`${timing}\n${text}`)
  }
  return `WEBVTT\n\n${cues.join('\n\n')}\n`
}

/** Finds a sidecar subtitle (`movie.srt` / `movie.vtt`) next to `current` in the queue. */
export function findSidecarSubtitle(queue: FileItem[], current: FileItem): FileItem | null {
  if (!current.name) return null
  const dot = current.name.lastIndexOf('.')
  const base = (dot > 0 ? current.name.slice(0, dot) : current.name).toLowerCase()
  return (
    queue.find((item) => {
      if (!item.id || item.id === current.id || !isSubtitleName(item.name)) return false
      const itemDot = item.name.lastIndexOf('.')
      const itemBase = itemDot > 0 ? item.name.slice(0, itemDot) : item.name
      return itemBase.toLowerCase() === base
    }) ?? null
  )
}

/** Natural A–Z ordering for the playlist queue (numbers sort naturally: 2 before 10). */
export function sortAZ(files: FileItem[]): FileItem[] {
  return [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
}

export type ZipEntry = { name: string; compressedSize: number; uncompressedSize: number; method: number }

const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP_CD_SIGNATURE = 0x02014b50
const ZIP64_MARKER = 0xffffffff

function findEOCD(view: DataView): number {
  const end = view.byteLength - 22
  const start = Math.max(0, view.byteLength - 66_000)
  for (let i = end; i >= start; i -= 1) {
    if (view.getUint32(i, true) === ZIP_EOCD_SIGNATURE) return i
  }
  return -1
}

function parseCentralDirectory(view: DataView, totalEntries: number): ZipEntry[] {
  const entries: ZipEntry[] = []
  let offset = 0
  while (offset + 46 <= view.byteLength && entries.length < totalEntries) {
    if (view.getUint32(offset, true) !== ZIP_CD_SIGNATURE) break
    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const uncompressedSize = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    if (offset + 46 + nameLength > view.byteLength) break
    const name = new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset + offset + 46, nameLength))
    entries.push({ name, compressedSize, uncompressedSize, method })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * Lists a ZIP archive's entries by reading only its central directory
 * (two small ranged GETs — the archive body is never downloaded).
 * Note: ZIP64 sizes (>4 GB) are not supported for in-browser listing.
 */
export async function listZipEntries(url: string): Promise<ZipEntry[]> {
  const tailResponse = await fetch(url, { headers: { Range: 'bytes=-131072' } })
  if (tailResponse.status === 200) {
    tailResponse.body?.cancel().catch(() => undefined)
    throw new Error('Server does not support ranged reads, so the archive cannot be listed without downloading it.')
  }
  if (!tailResponse.ok) throw new Error(`Archive listing failed (HTTP ${tailResponse.status}).`)

  const tail = new Uint8Array(await tailResponse.arrayBuffer())
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  const eocdOffset = findEOCD(tailView)
  if (eocdOffset < 0) throw new Error('ZIP directory not found — is this really a ZIP archive?')

  const totalEntries = tailView.getUint16(eocdOffset + 10, true)
  const cdSize = tailView.getUint32(eocdOffset + 12, true)
  const cdOffset = tailView.getUint32(eocdOffset + 16, true)
  if (cdSize === ZIP64_MARKER || cdOffset === ZIP64_MARKER) throw new Error('ZIP64 archives are not supported for in-browser listing yet.')

  const contentRange = tailResponse.headers.get('Content-Range')
  const tailStart = contentRange ? Number(/bytes\s+(\d+)-/.exec(contentRange)?.[1] ?? 0) : 0

  let cdBytes: Uint8Array | null = null
  if (cdOffset >= tailStart && cdOffset + cdSize <= tailStart + tail.byteLength) {
    cdBytes = tail.slice(cdOffset - tailStart, cdOffset - tailStart + cdSize)
  } else {
    const cdResponse = await fetch(url, { headers: { Range: `bytes=${cdOffset}-${cdOffset + cdSize - 1}` } })
    if (cdResponse.ok) cdBytes = new Uint8Array(await cdResponse.arrayBuffer())
  }
  if (!cdBytes) throw new Error('Could not read the ZIP directory.')

  return parseCentralDirectory(new DataView(cdBytes.buffer, cdBytes.byteOffset, cdBytes.byteLength), totalEntries)
}
