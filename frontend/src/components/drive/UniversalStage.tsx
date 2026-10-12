import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Download, FileArchive, FileAudio, FileText, Film, Image as ImageIcon, Loader2, Music, X } from 'lucide-react'
import type { FileItem } from '@/data/drive-data'
import { apiFetch, formatBytes } from '@/lib/api'
import { createPlyr, ensurePlyr } from '@/lib/plyr'
import { officeViewerUrl } from '@/lib/preview'
import { findSidecarSubtitle, getStageKind, listZipEntries, sortAZ, srtToVtt, type ZipEntry } from '@/lib/stage'
import { ModernVideoPlayer } from '@/components/drive/ModernVideoPlayer'
import { InteractivePdfViewer } from '@/components/drive/InteractivePdfViewer'

type PlyrInstance = { destroy: () => void }

export type UniversalStageProps = {
  file: FileItem
  /** All stage-capable files in the current view; the component sorts them A–Z itself. */
  queue: FileItem[]
  previewUrl: string
  resolvePreviewUrl: (file: FileItem) => Promise<string>
  onPlayFile: (file: FileItem) => void
  onDownload: (file: FileItem) => void
  onMediaError: () => void
  /** Dismiss the stage (Escape / close button). */
  onClose: () => void
}

/** Small tinted icon representing the file's media type for the top bar. */
function FileTypeIcon({ mimeType }: { mimeType?: string }) {
  const mime = mimeType ?? ''
  if (mime.startsWith('video/')) return <Film className="h-4 w-4 text-zinc-300" />
  if (mime.startsWith('audio/')) return <Music className="h-4 w-4 text-zinc-300" />
  if (mime.startsWith('image/')) return <ImageIcon className="h-4 w-4 text-zinc-300" />
  if (mime === 'application/pdf') return <FileText className="h-4 w-4 text-rose-400" />
  if (mime.startsWith('text/')) return <FileAudio className="h-4 w-4 text-zinc-300" />
  return <FileText className="h-4 w-4 text-zinc-300" />
}

/**
 * Universal Stage: single surface for streaming playback from the vault.
 * - video/audio → Plyr with sidecar `.srt`/`.vtt` subtitles and A–Z playlist
 *   navigation (auto-advance on end, arrow-key seeking between items)
 * - image/pdf/office → inline viewers
 * - zip → archive manifest listing via ranged reads of the central directory
 */
export function UniversalStage({ file, queue, previewUrl, resolvePreviewUrl, onPlayFile, onDownload, onMediaError, onClose }: UniversalStageProps) {
  const kind = getStageKind(file)
  const isPdf = kind === 'document' && (file.mimeType ?? '') === 'application/pdf'
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null)
  const [subtitleUrl, setSubtitleUrl] = useState('')
  const [zipEntries, setZipEntries] = useState<ZipEntry[] | null>(null)
  const [zipError, setZipError] = useState('')
  const [zipLoading, setZipLoading] = useState(false)
  const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [pdfError, setPdfError] = useState('')

  const sortedQueue = useMemo(() => sortAZ(queue.filter((item) => item.id && getStageKind(item))), [queue])
  const queueIndex = sortedQueue.findIndex((item) => item.id === file.id)
  const previousFile = queueIndex > 0 ? sortedQueue[queueIndex - 1] : undefined
  const nextFile = queueIndex >= 0 && queueIndex < sortedQueue.length - 1 ? sortedQueue[queueIndex + 1] : undefined
  const subtitle = kind === 'video' || kind === 'audio' ? findSidecarSubtitle(sortedQueue, file) : null

  // Plyr player lifecycle for audio playback (video uses ModernVideoPlayer).
  useEffect(() => {
    if (kind !== 'audio' || !previewUrl) return undefined
    let disposed = false
    let instance: PlyrInstance | null = null
    ensurePlyr().then(() => {
      if (disposed || !mediaRef.current) return
      instance = createPlyr(mediaRef.current as HTMLVideoElement)
    }).catch(() => undefined)
    return () => {
      disposed = true
      instance?.destroy()
    }
  }, [kind, previewUrl])

  // Auto-advance to the next A–Z item when audio playback ends.
  useEffect(() => {
    const element = mediaRef.current
    if (!element || kind !== 'audio') return undefined
    const onEnded = () => {
      if (nextFile) onPlayFile(nextFile)
    }
    element.addEventListener('ended', onEnded)
    return () => element.removeEventListener('ended', onEnded)
  }, [kind, nextFile, onPlayFile, previewUrl])

  // Resolve the sidecar subtitle stream URL (token-protected like the video itself).
  // `.srt` files are converted to WebVTT in-memory because browsers only render VTT tracks.
  useEffect(() => {
    setSubtitleUrl('')
    if (!subtitle?.id || !subtitle.name) return undefined
    let disposed = false
    let objectUrl = ''
    resolvePreviewUrl(subtitle)
      .then(async (url) => {
        if (/\.srt$/i.test(subtitle.name)) {
          const response = await fetch(url)
          if (!response.ok) throw new Error('Failed to load subtitle file.')
          objectUrl = URL.createObjectURL(new Blob([srtToVtt(await response.text())], { type: 'text/vtt' }))
          if (!disposed) setSubtitleUrl(objectUrl)
        } else if (!disposed) {
          setSubtitleUrl(url)
        }
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [subtitle?.id, subtitle?.name, resolvePreviewUrl])

  // ZIP manifest: read only the central directory via ranged requests.
  useEffect(() => {
    if (kind !== 'zip' || !previewUrl) return undefined
    let disposed = false
    setZipLoading(true)
    setZipError('')
    setZipEntries(null)
    listZipEntries(previewUrl).then((entries) => {
      if (disposed) return
      setZipEntries(entries)
      setZipLoading(false)
    }).catch((error) => {
      if (disposed) return
      setZipError(error instanceof Error ? error.message : 'Failed to list archive.')
      setZipLoading(false)
    })
    return () => {
      disposed = true
    }
  }, [kind, previewUrl])

  // Keyboard navigation: Escape closes; arrows move between files EXCEPT while a
  // video is open (the ModernVideoPlayer owns ←/→ for seeking in that case).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') { onClose(); return }
      if (kind === 'video') return
      if (event.key === 'ArrowRight' && nextFile) onPlayFile(nextFile)
      if (event.key === 'ArrowLeft' && previousFile) onPlayFile(previousFile)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [kind, nextFile, previousFile, onPlayFile, onClose])

  // PDF inline loader: fetch the token-scoped backend stream into an ArrayBuffer so
  // the interactive annotator (pdf.js render + pdf-lib bake) can use the raw bytes.
  // `pdfLoading` stays true until the viewer reports readiness (page 1 rendered),
  // so exactly ONE loader is shown — no double skeleton, no interstitial gap.
  useEffect(() => {
    if (kind !== 'document' || (file.mimeType ?? '') !== 'application/pdf' || !previewUrl) return undefined
    let active = true
    setPdfLoading(true)
    setPdfError('')
    setPdfBytes(null)
    fetch(previewUrl)
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to load PDF (${response.status})`)
        return response.arrayBuffer()
      })
      .then((buffer) => { if (active) setPdfBytes(buffer) })
      .catch((error: unknown) => {
        if (!active) return
        setPdfError(error instanceof Error ? error.message : 'Failed to load PDF')
        setPdfLoading(false)
      })
    return () => { active = false }
  }, [kind, file.mimeType, previewUrl, file.id])

  let stageContent = null
  if (kind === 'video') {
    stageContent = (
      <ModernVideoPlayer
        src={previewUrl}
        mimeType={file.mimeType}
        autoPlay
        onEnded={() => { if (nextFile) onPlayFile(nextFile) }}
        onError={onMediaError}
      >
        {subtitleUrl && subtitle ? <track kind="captions" src={subtitleUrl} srcLang="en" label="Subtitles" default /> : null}
      </ModernVideoPlayer>
    )
  } else if (kind === 'audio') {
    stageContent = (
      <div className="flex w-full max-w-md flex-col items-center gap-5 rounded-2xl border border-white/10 bg-zinc-900/80 p-8 shadow-2xl backdrop-blur-xl">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-blue-500/20 bg-blue-500/10 text-blue-400">
          <Music className="h-8 w-8" />
        </div>
        <p className="w-full truncate text-center font-semibold text-white">{file.name}</p>
        <audio ref={(element) => { mediaRef.current = element }} controls autoPlay preload="metadata" src={previewUrl} onError={onMediaError} className="w-full" />
      </div>
    )
  } else if (kind === 'image') {
    stageContent = (
      <img
        src={previewUrl}
        alt={file.name}
        className="max-h-full max-w-full rounded-2xl border border-white/[0.08] object-contain shadow-2xl"
        onError={onMediaError}
      />
    )
  } else if (kind === 'document') {
    // True interactive annotator for real PDFs: pdf.js renders pages, an SVG
    // overlay captures highlight/draw/text, pdf-lib bakes them in, and edits
    // auto-save to Google Drive via PUT /files/:id/content. Google-Docs exports
    // (non-PDF documents) have no editable source, so they stream read-only.
    if (isPdf) {
      if (pdfError) {
        stageContent = (
          <div className="flex h-[88vh] w-full max-w-5xl flex-col items-center justify-center gap-4 rounded-2xl border border-white/10 bg-zinc-950 p-6 text-center shadow-2xl">
            <FileText className="h-10 w-10 text-rose-400" />
            <p className="text-sm text-rose-300">{pdfError}</p>
            <button type="button" onClick={() => onDownload(file)} className="rounded-xl bg-white/10 px-4 py-2 text-xs font-medium text-white transition hover:bg-white/20">
              Download PDF instead
            </button>
          </div>
        )
      } else if (pdfBytes) {
        stageContent = (
          <InteractivePdfViewer
            pdfBytes={pdfBytes}
            fileName={file.name}
            onReady={() => setPdfLoading(false)}
            onSave={async (bytes) => {
              await apiFetch(`/files/${file.id}/content`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/pdf' },
                body: bytes.slice().buffer as ArrayBuffer,
              })
            }}
          />
        )
      }
    } else {
      stageContent = <iframe src={`${previewUrl}#navpanes=0`} title={file.name} className="h-[88vh] w-full max-w-5xl rounded-2xl border border-white/10 bg-zinc-900 shadow-2xl" />
    }
  } else if (kind === 'office') {
    stageContent = (
      <iframe src={officeViewerUrl(previewUrl)} title={file.name} className="h-full w-full rounded-2xl border border-white/[0.08] bg-white shadow-2xl" />
    )
  } else if (kind === 'zip') {
    stageContent = (
      <div className="flex h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/80 shadow-2xl backdrop-blur-xl">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
          <FileArchive className="h-4 w-4 shrink-0 text-amber-500" />
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-white">{file.name}</p>
          <span className="shrink-0 text-[11px] font-medium text-zinc-400">{file.size}</span>
          <button type="button" onClick={() => onDownload(file)} className="rounded-lg border border-white/10 p-1.5 text-zinc-400 transition hover:bg-white/10" aria-label="Download archive">
            <Download className="h-4 w-4" />
          </button>
        </div>
        {zipLoading ? <div className="flex items-center justify-center gap-2 p-8 text-sm text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" />Reading archive directory...</div> : null}
        {zipError ? <div className="p-8 text-center text-sm text-rose-400">{zipError}</div> : null}
        {zipEntries ? (
          <ul className="min-h-0 flex-1 overflow-y-auto divide-y divide-white/5">
            {zipEntries.map((entry, index) => (
              <li key={`${entry.name}-${index}`} className="flex items-center gap-3 px-4 py-2 text-sm">
                <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                <span className="min-w-0 flex-1 truncate text-zinc-200">{entry.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-zinc-500">{entry.uncompressedSize.toLocaleString()} B</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    )
  } else {
    stageContent = (
      <div className="flex max-w-sm flex-col items-center gap-4 rounded-2xl border border-white/10 bg-zinc-900/80 p-8 text-center shadow-2xl backdrop-blur-xl">
        <FileText className="h-12 w-12 text-zinc-500" />
        <div className="grid gap-1">
          <p className="text-sm font-medium text-white">{file.name}</p>
          <p className="text-xs text-zinc-400">Preview is not available for this file type.</p>
        </div>
        <button type="button" onClick={() => onDownload(file)} className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-blue-500">
          <Download className="h-4 w-4" />Download File
        </button>
      </div>
    )
  }

  const fileSize = file.sizeBytes ? formatBytes(file.sizeBytes) : file.size
  const counter = queueIndex >= 0 ? `${queueIndex + 1} of ${sortedQueue.length}` : ''

  return (
    <div className="fixed inset-0 z-50 flex animate-in flex-col bg-black/90 text-white backdrop-blur-2xl fade-in select-none duration-200">
      {/* Floating glass top bar */}
      <header className="relative z-30 flex h-16 w-full shrink-0 items-center justify-between border-b border-white/[0.08] bg-black/40 px-6 backdrop-blur-md">
        {/* Left: file info */}
        <div className="flex min-w-0 items-center gap-3">
          <div className="rounded-lg border border-white/10 bg-white/10 p-2 text-zinc-300">
            <FileTypeIcon mimeType={file.mimeType} />
          </div>
          <div className="min-w-0">
            <h2 className="max-w-md truncate text-sm font-semibold text-white" title={file.name}>{file.name}</h2>
            <p className="font-mono text-xs text-zinc-400">
              {fileSize}{counter ? ` • ${counter}` : ''}
            </p>
          </div>
        </div>

        {/* Right: actions */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onDownload(file)}
            className="flex cursor-pointer items-center gap-2 rounded-xl border border-white/10 bg-white/10 px-3.5 py-1.5 text-xs font-medium text-white transition-all hover:bg-white/20"
            title="Download file"
          >
            <Download className="h-4 w-4" />
            <span>Download</span>
          </button>
          <div className="mx-1 h-5 w-px bg-white/10" />
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-xl bg-white/5 p-2 text-zinc-400 transition-colors hover:bg-white/15 hover:text-white"
            title="Close (Esc)"
            aria-label="Close preview"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </header>

      {/* Center stage: dynamic viewport with floating edge chevrons */}
      <div className="relative flex w-full flex-1 items-center justify-center overflow-hidden p-4 lg:p-8">
        {previousFile ? (
          <button
            type="button"
            onClick={() => onPlayFile(previousFile)}
            className="absolute left-6 z-20 flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border border-white/15 bg-black/60 text-white backdrop-blur-lg transition-all hover:scale-105 hover:bg-white/20"
            title="Previous (←)"
            aria-label="Previous file"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
        ) : null}

        {nextFile ? (
          <button
            type="button"
            onClick={() => onPlayFile(nextFile)}
            className="absolute right-6 z-20 flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border border-white/15 bg-black/60 text-white backdrop-blur-lg transition-all hover:scale-105 hover:bg-white/20"
            title="Next (→)"
            aria-label="Next file"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        ) : null}

        <div className="relative flex h-full max-h-[85vh] w-full max-w-6xl items-center justify-center">{stageContent}</div>

        {/* Single unified PDF loader — owned here so there is exactly ONE indicator
            that persists from fetch through pdf.js parse until page 1 renders. */}
        {isPdf && pdfLoading ? (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-zinc-950/90 backdrop-blur-md">
            <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
            <p className="font-mono text-xs text-zinc-400">Loading document...</p>
          </div>
        ) : null}
      </div>
    </div>
  )
}
