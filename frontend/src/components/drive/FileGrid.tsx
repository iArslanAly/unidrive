import { Film, HardDrive, MoreVertical, Play, Star } from 'lucide-react'

/** Small uppercase file-type badge label (MP4, PDF, …) derived from the card kind. */
function typeChipLabel(kind: FileItem['kind']): string {
  if (kind === 'video') return 'MP4'
  if (kind === 'image') return 'IMG'
  if (kind === 'pdf') return 'PDF'
  return 'FILE'
}

/** Format seconds as a compact MM:SS / H:MM:SS duration string. */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const hrs = Math.floor(total / 3600)
  const mins = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${mins}:${pad(secs)}`
}

/** Bottom-right media meta pill: duration for video/audio, page count for PDF. */
function mediaMetaLabel(file: FileItem): string | null {
  if ((file.kind === 'video' || (file.mimeType ?? '').startsWith('audio/')) && typeof file.durationSeconds === 'number') {
    return formatDuration(file.durationSeconds)
  }
  if (file.kind === 'pdf' && typeof file.pageCount === 'number' && file.pageCount > 0) {
    return `${file.pageCount} ${file.pageCount === 1 ? 'pg' : 'pgs'}`
  }
  return null
}
import type { MouseEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Card } from '@/components/ui/card'
import { FileIcon } from '@/components/drive/FileIcon'
import type { FileItem } from '@/data/drive-data'
import { cn } from '@/lib/utils'
import { formatBytes, formatDate } from '@/lib/api'
import { getCachedThumb, idbGet, setCachedThumb, runThumbTask, useThumbVisible } from '@/lib/thumbQueue'

/**
 * Authenticated image thumbnail. Resolves a token-protected preview URL via the
 * caller-provided resolver, streams it as a blob (the preview endpoint is
 * token-scoped, not cookie-scoped), and shows an object-URL cover image. Falls
 * back to the flat FileIcon on any resolve/load failure so the card never breaks.
 */
function ImageThumb({ file, resolveThumbUrl, iconClass }: { file: FileItem; resolveThumbUrl?: (f: FileItem) => Promise<string>; iconClass: string }) {
  // Native Google Drive thumbnailLink is the fast path — no token, no stream.
  const cached = getCachedThumb(file.id)
  const [src, setSrc] = useState(file.thumbnailUrl || cached || '')
  const [boxRef, visible] = useThumbVisible<HTMLDivElement>()
  useEffect(() => {
    // Fast path: native Drive thumbnail already rendered.
    if (file.thumbnailUrl) { setSrc(file.thumbnailUrl); return }
    const cachedThumb = getCachedThumb(file.id)
    if (cachedThumb) { setSrc(cachedThumb); return }
    if (!visible || !resolveThumbUrl) return
    let cancelled = false
    let objectUrl = ''
    const timer = setTimeout(() => {
      runThumbTask(async () => {
        const url = await resolveThumbUrl(file)
        const response = await fetch(url)
        const blob = await response.blob()
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setCachedThumb(file.id, objectUrl)
        if (!cancelled) setSrc(objectUrl)
      }).catch(() => { if (!cancelled) setSrc('') })
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [file, resolveThumbUrl, visible])

  if (!src) return <div ref={boxRef} className="flex h-full w-full items-center justify-center"><FileIcon kind={file.kind} className={iconClass} /></div>
  return <div ref={boxRef} className="h-full w-full"><img src={src} alt={file.name} loading="lazy" className="h-full w-full rounded-lg object-cover" /></div>
}

/**
 * Real video poster generator. Streams the token-protected preview URL into an
 * offscreen <video preload="metadata">, seeks to ~1s (or duration/2) once metadata
 * is ready, draws that frame onto an offscreen <canvas>, and caches the data URL.
 *
 * Performance: the heavy work is funneled through `runThumbTask` (max 1 concurrent
 * extraction) and delayed 300ms so `GET /files`/`GET /folders` never queue behind
 * media streams. Once cached, revisiting the folder renders the poster instantly
 * with no network, token fetch, or <video> element. An AbortController + video
 * teardown cancels in-flight work the moment the card unmounts (folder change).
 */
function VideoThumb({ file, resolveThumbUrl, onFail }: { file: FileItem; resolveThumbUrl?: (f: FileItem) => Promise<string>; onFail: () => void }) {
  const cached = getCachedThumb(file.id)
  const [poster, setPoster] = useState(file.thumbnailUrl || cached || '')
  const [loading, setLoading] = useState(!file.thumbnailUrl && !cached)
  const onFailRef = useRef(onFail)
  onFailRef.current = onFail
  const [boxRef, visible] = useThumbVisible<HTMLDivElement>()
  useEffect(() => {
    // Fast path: native Google Drive thumbnail — render directly, no stream.
    if (file.thumbnailUrl) { setPoster(file.thumbnailUrl); setLoading(false); return }
    const cachedThumb = getCachedThumb(file.id)
    if (cachedThumb) { setPoster(cachedThumb); setLoading(false); return }
    if (!visible) return
    // Async IndexedDB fallback for a poster generated in a previous session that
    // hasn't been hydrated into the sync mirror yet.
    if (!resolveThumbUrl && file.id) {
      void idbGet(file.id).then((stored) => { if (stored) { setCachedThumb(file.id, stored); setPoster(stored); setLoading(false) } else { setLoading(false); onFailRef.current() } })
      return
    }
    if (!resolveThumbUrl) { setLoading(false); onFailRef.current(); return }
    let cancelled = false
    let objectUrl = ''
    let video: HTMLVideoElement | null = null
    const controller = new AbortController()
    // Delay so navigation requests win the connection race, then serialize via
    // the queue (max 2 <video> streams open at once).
    const timer = setTimeout(() => {
      runThumbTask(async () => {
        if (cancelled || controller.signal.aborted) throw new Error('aborted')
        const url = await resolveThumbUrl(file)
        const response = await fetch(url, { signal: controller.signal })
        const blob = await response.blob()
        if (cancelled || controller.signal.aborted) return
        objectUrl = URL.createObjectURL(blob)
        video = document.createElement('video')
        video.preload = 'metadata'
        video.muted = true
        video.crossOrigin = 'anonymous'
        video.src = objectUrl

        const draw = () => {
          if (!video || cancelled || controller.signal.aborted) return
          const canvas = document.createElement('canvas')
          canvas.width = video.videoWidth || 320
          canvas.height = video.videoHeight || 180
          const ctx = canvas.getContext('2d')
          if (!ctx) { setLoading(false); onFailRef.current(); return }
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          const dataUrl = canvas.toDataURL('image/jpeg', 0.7)
          setCachedThumb(file.id, dataUrl)
          setPoster(dataUrl)
          setLoading(false)
        }

        video.onloadeddata = () => {
          if (!video) return
          try { video.currentTime = Math.min(1.0, (video.duration || 2) / 2) } catch { draw() }
        }
        video.onseeked = draw
        video.onerror = () => { if (!cancelled) { setLoading(false); onFailRef.current() } }
        video.load()
      }).catch(() => { if (!cancelled && !controller.signal.aborted) { setLoading(false); onFailRef.current() } })
    }, 150)

    return () => {
      cancelled = true
      clearTimeout(timer)
      controller.abort()
      if (video) {
        // Fully tear down the stream: detach handlers, clear src, and load() to
        // abort any in-flight network read on the <video> element.
        video.onloadeddata = null
        video.onseeked = null
        video.onerror = null
        video.src = ''
        video.load()
      }
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [file, resolveThumbUrl, visible])

  if (poster) return <div ref={boxRef} className="h-full w-full"><img src={poster} alt={file.name} className="h-full w-full object-cover" /></div>
  if (loading) return <div ref={boxRef} className="h-full w-full"><VideoSkeleton /></div>
  return <div ref={boxRef} className="h-full w-full" />
}

/** Animated skeleton pulse shown while a video poster is being extracted. */
function VideoSkeleton() {
  return (
    <div className="absolute inset-0 flex items-center justify-center animate-pulse bg-gradient-to-tr from-zinc-200/70 via-zinc-100 to-zinc-200/70 dark:from-zinc-900 dark:via-zinc-800/60 dark:to-zinc-900">
      <Film className="h-8 w-8 text-zinc-400/40 dark:text-white/10" strokeWidth={1.5} />
    </div>
  )
}

/** Failure plate shown for video cards when poster extraction fails outright. */
function VideoFallback() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-tr from-zinc-100 via-zinc-200 to-zinc-100 dark:from-slate-950 dark:via-indigo-950/40 dark:to-zinc-900">
      <Film className="h-10 w-10 text-zinc-400/60 dark:text-white/10" strokeWidth={1.5} />
    </div>
  )
}

/**
 * Modern media file cards (Frame.io / Linear workstation aesthetic): an
 * edge-to-edge 16:9 preview stage with a centered frosted play pill, a floating
 * glass format badge, an optional duration / page-count pill, and a hover-revealed
 * quick-action cluster (select + star + menu), followed by a clean metadata footer
 * (size • date on the left, storage-provider badge on the right). Cards flow in a
 * responsive auto-fill grid — no squished slivers.
 */
export function FileGrid({
  files,
  selectedFileIds = new Set<string>(),
  selectedFileId,
  onFileContextMenu,
  onToggleFile,
  onFileOpen,
  onFileSelect,
  resolveThumbUrl,
}: {
  files: FileItem[]
  selectedFileIds?: Set<string>
  /** Single-click "active" file driving the Right Inspector panel. */
  selectedFileId?: string | null
  onFileContextMenu?: (event: MouseEvent<HTMLElement>, file: FileItem) => void
  onToggleFile?: (file: FileItem) => void
  /** Double-click handler — opens the Universal Stage preview. */
  onFileOpen?: (file: FileItem) => void
  /** Single-click handler — selects the file and opens the Right Inspector. */
  onFileSelect?: (file: FileItem) => void
  /** Resolves a token-protected preview URL for authenticated thumbnails (images). */
  resolveThumbUrl?: (file: FileItem) => Promise<string>
}) {
  return (
    <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-5">
      {files.map((file) => {
        const selected = selectedFileIds.has(file.id ?? '')
        // Inspector-active card (single-click selection) — distinct from the
        // multi-select checkbox ring below.
        const inspectorActive = selectedFileId != null && file.id === selectedFileId
        // Per-card fallback flag: video poster failed/pending → show gradient watermark.
        const [videoFallback, setVideoFallback] = useState(false)
        return (
          <Card
            key={file.id ?? file.name}
            data-file-card=""
            draggable
            onDragStart={(event) => { event.dataTransfer.setData('text/plain', file.id ?? ''); event.dataTransfer.effectAllowed = 'move' }}
            onClick={() => onFileSelect?.(file)}
            onDoubleClick={() => onFileOpen?.(file)}
            onContextMenu={(event) => onFileContextMenu?.(event, file)}
            className={cn(
              'group relative flex cursor-pointer flex-col overflow-hidden rounded-2xl border transition-all duration-200',
              inspectorActive
                ? 'border-blue-500 bg-zinc-900/90 shadow-xl shadow-blue-500/10 ring-1 ring-blue-500/50'
                : selected
                  ? 'border-blue-500/60 bg-zinc-900/70 ring-1 ring-blue-500/30'
                  : 'border-white/[0.07] bg-zinc-900/40 hover:-translate-y-1 hover:border-white/20 hover:bg-zinc-900/80 hover:shadow-2xl'
            )}
          >
            {/* Edge-to-edge 16:9 thumbnail stage: poster / video canvas / image / fallback. */}
            <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden border-b border-white/[0.06] bg-zinc-950 text-zinc-300">
              {file.kind === 'video' ? (
                /* Thumbnail + centered play live in an absolute layer so the poster
                   never participates in flex flow and can never shove the button. */
                <div className="absolute inset-0">
                  {videoFallback ? <VideoFallback /> : <VideoThumb file={file} resolveThumbUrl={resolveThumbUrl} onFail={() => setVideoFallback(true)} />}
                  {/* DEAD-CENTER glass play pill — clicking it opens the Universal Stage directly. */}
                  <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
                    <button
                      type="button"
                      className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white shadow-xl backdrop-blur-md transition-all duration-200 group-hover:scale-110 group-hover:border-blue-400 group-hover:bg-blue-600"
                      onClick={(event) => { event.stopPropagation(); onFileOpen?.(file) }}
                      aria-label={`Open ${file.name} in full player`}
                    >
                      <Play className="ml-0.5 h-4 w-4 fill-current" />
                    </button>
                  </div>
                </div>
              ) : file.kind === 'image' ? (
                <ImageThumb file={file} resolveThumbUrl={resolveThumbUrl} iconClass="h-9 w-9" />
              ) : file.kind === 'pdf' ? (
                <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-red-500/10 text-red-500 ring-1 ring-red-500/20 dark:bg-red-500/10 dark:text-red-400 dark:ring-red-500/20">
                  <FileIcon kind={file.kind} className="h-6 w-6" />
                </span>
              ) : (
                <FileIcon kind={file.kind} className="h-9 w-9" />
              )}
              {/* Top-left hover cluster: select checkbox + quick star + actions menu. */}
              <div className={cn('absolute left-2.5 top-2.5 z-20 flex items-center gap-1.5 transition-opacity duration-200', selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}>
                <input type="checkbox" className="h-4 w-4 cursor-pointer rounded-full border border-zinc-300 bg-white/90 accent-blue-600 ring-0 checked:bg-blue-600 focus:ring-0 dark:border-white/20 dark:bg-black/60 dark:checked:bg-blue-600" checked={selected} onChange={() => onToggleFile?.(file)} onClick={(event) => event.stopPropagation()} aria-label={`Select ${file.name}`} />
                <button
                  type="button"
                  className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-black/50 text-zinc-300 backdrop-blur-md transition-colors hover:text-amber-300"
                  onClick={(event) => { event.stopPropagation(); onFileContextMenu?.(event, file) }}
                  aria-label={`Star ${file.name}`}
                  title="Star"
                >
                  <Star className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-black/50 text-zinc-300 backdrop-blur-md transition-colors hover:text-white"
                  onClick={(event) => { event.stopPropagation(); onFileContextMenu?.(event, file) }}
                  aria-label={`Open ${file.name} menu`}
                  title="More actions"
                >
                  <MoreVertical className="h-3.5 w-3.5" />
                </button>
              </div>
              {/* File-format tag (top-right), always visible. */}
              <span className="absolute right-2.5 top-2.5 z-20 rounded-md border border-white/10 bg-black/60 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-300 backdrop-blur-md">{typeChipLabel(file.kind)}</span>
              {/* Duration / page-count pill (bottom-right), when metadata is available. */}
              {mediaMetaLabel(file) ? (
                <span className="absolute bottom-2.5 right-2.5 z-20 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300 backdrop-blur-md">{mediaMetaLabel(file)}</span>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5 p-3.5">
              <h3 className="line-clamp-1 text-xs font-semibold tracking-tight text-zinc-200 transition-colors group-hover:text-blue-400" title={file.name}>{file.name}</h3>
              <div className="mt-0.5 flex items-center justify-between font-mono text-[11px] text-zinc-500">
                <span className="truncate">{file.sizeBytes ? formatBytes(file.sizeBytes) : file.size} • {file.createdAt ? formatDate(file.createdAt) : file.date}</span>
                <span className="ml-2 inline-flex shrink-0 items-center gap-1 rounded-md border border-white/[0.06] bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-zinc-400" title={file.accountProvider ?? 'Google Drive'}>
                  <HardDrive className="h-3 w-3 text-zinc-500" />
                  <span>Drive</span>
                </span>
              </div>
            </div>
          </Card>
        )
      })}
    </div>
  )
}
