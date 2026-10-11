import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Download, FileArchive, FileText, Loader2, Music, Play } from 'lucide-react'
import type { FileItem } from '@/data/drive-data'
import { createPlyr, ensurePlyr } from '@/lib/plyr'
import { officeViewerUrl } from '@/lib/preview'
import { findSidecarSubtitle, getStageKind, listZipEntries, sortAZ, srtToVtt, type ZipEntry } from '@/lib/stage'

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
}

/**
 * Universal Stage: single surface for streaming playback from the vault.
 * - video/audio → Plyr with sidecar `.srt`/`.vtt` subtitles and A–Z playlist
 *   navigation (auto-advance on end, arrow-key seeking between items)
 * - image/pdf/office → inline viewers
 * - zip → archive manifest listing via ranged reads of the central directory
 */
export function UniversalStage({ file, queue, previewUrl, resolvePreviewUrl, onPlayFile, onDownload, onMediaError }: UniversalStageProps) {
  const kind = getStageKind(file)
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null)
  const [subtitleUrl, setSubtitleUrl] = useState('')
  const [zipEntries, setZipEntries] = useState<ZipEntry[] | null>(null)
  const [zipError, setZipError] = useState('')
  const [zipLoading, setZipLoading] = useState(false)

  const sortedQueue = useMemo(() => sortAZ(queue.filter((item) => item.id && getStageKind(item))), [queue])
  const queueIndex = sortedQueue.findIndex((item) => item.id === file.id)
  const previousFile = queueIndex > 0 ? sortedQueue[queueIndex - 1] : undefined
  const nextFile = queueIndex >= 0 && queueIndex < sortedQueue.length - 1 ? sortedQueue[queueIndex + 1] : undefined
  const subtitle = kind === 'video' || kind === 'audio' ? findSidecarSubtitle(sortedQueue, file) : null
  const showPlaylist = (kind === 'video' || kind === 'audio') && sortedQueue.length > 1

  // Plyr player lifecycle for video/audio playback.
  useEffect(() => {
    if ((kind !== 'video' && kind !== 'audio') || !previewUrl) return undefined
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

  // Auto-advance to the next A–Z item when playback ends (never loops backwards).
  useEffect(() => {
    const element = mediaRef.current
    if (!element || (kind !== 'video' && kind !== 'audio')) return undefined
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

  // Arrow-key navigation between playlist items.
  useEffect(() => {
    if (kind !== 'video' && kind !== 'audio') return undefined
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'ArrowRight' && nextFile) onPlayFile(nextFile)
      if (event.key === 'ArrowLeft' && previousFile) onPlayFile(previousFile)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [kind, nextFile, previousFile, onPlayFile])

  const navBar = (kind === 'video' || kind === 'audio') && queueIndex >= 0 ? (
    <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 dark:border-zinc-800/80 dark:bg-zinc-900/60">
      <button
        type="button"
        disabled={!previousFile}
        onClick={() => previousFile && onPlayFile(previousFile)}
        className="rounded-lg border border-slate-200 p-1.5 text-slate-500 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-30"
        aria-label="Previous file"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <div className="min-w-0 flex-1 text-center">
        <p className="truncate text-sm font-semibold text-slate-700">{file.name}</p>
        <p className="text-[11px] font-medium text-slate-400">Track {queueIndex + 1} of {sortedQueue.length} · ← → to skip</p>
      </div>
      <button
        type="button"
        disabled={!nextFile}
        onClick={() => nextFile && onPlayFile(nextFile)}
        className="rounded-lg border border-slate-200 p-1.5 text-slate-500 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-30"
        aria-label="Next file"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => onDownload(file)}
        className="rounded-lg border border-slate-200 p-1.5 text-slate-500 transition hover:bg-slate-50"
        aria-label="Download file"
      >
        <Download className="h-4 w-4" />
      </button>
    </div>
  ) : null

  let stageContent = null
  if (kind === 'video') {
    stageContent = (
      <div className="shared-video-shell">
        <video ref={(element) => { mediaRef.current = element }} controls playsInline preload="metadata" onError={onMediaError}>
          <source src={previewUrl} type={file.mimeType} />
          {subtitleUrl && subtitle ? <track kind="captions" src={subtitleUrl} srcLang="en" label="Subtitles" default /> : null}
        </video>
      </div>
    )
  } else if (kind === 'audio') {
    stageContent = (
      <div className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-8 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/60">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-50 text-blue-600"><Music className="h-5 w-5" /></span>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-slate-800">{file.name}</p>
            <p className="text-xs text-slate-400">{file.size}</p>
          </div>
        </div>
        <audio ref={(element) => { mediaRef.current = element }} controls preload="metadata" src={previewUrl} onError={onMediaError} className="w-full" />
      </div>
    )
  } else if (kind === 'image') {
    stageContent = <img src={previewUrl} alt={file.name} className="max-h-full max-w-full object-contain shadow-2xl shadow-black/20" onError={onMediaError} />
  } else if (kind === 'document') {
    stageContent = <iframe src={previewUrl} title={file.name} className="h-full w-full border-0 bg-white" />
  } else if (kind === 'office') {
    stageContent = <iframe src={officeViewerUrl(previewUrl)} title={file.name} className="h-full w-full border-0 bg-white" />
  } else if (kind === 'zip') {
    stageContent = (
      <div className="flex h-full w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-zinc-800/80 dark:bg-zinc-900/60">
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
          <FileArchive className="h-4 w-4 shrink-0 text-amber-500" />
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-700">{file.name}</p>
          <span className="shrink-0 text-[11px] font-medium text-slate-400">{file.size}</span>
          <button type="button" onClick={() => onDownload(file)} className="rounded-lg border border-slate-200 p-1.5 text-slate-500 transition hover:bg-slate-50" aria-label="Download archive">
            <Download className="h-4 w-4" />
          </button>
        </div>
        {zipLoading ? <div className="flex items-center justify-center gap-2 p-8 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Reading archive directory...</div> : null}
        {zipError ? <div className="p-8 text-center text-sm text-red-600">{zipError}</div> : null}
        {zipEntries ? (
          <ul className="min-h-0 flex-1 overflow-y-auto divide-y divide-slate-100">
            {zipEntries.map((entry, index) => (
              <li key={`${entry.name}-${index}`} className="flex items-center gap-3 px-4 py-2 text-sm">
                <FileText className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                <span className="min-w-0 flex-1 truncate text-slate-700">{entry.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-slate-400">{entry.uncompressedSize.toLocaleString()} B</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    )
  } else {
    stageContent = (
      <div className="flex flex-col items-center gap-3 p-6 text-center">
        <FileText className="h-8 w-8 text-slate-300" />
        <p className="text-sm text-slate-500">Preview not available for this file type. Use Download instead.</p>
        <button type="button" onClick={() => onDownload(file)} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-50">
          <Download className="h-4 w-4" />Download
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full w-full min-h-0">
      <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
        {navBar}
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">{stageContent}</div>
      </div>
      {showPlaylist ? (
        <aside className="flex w-60 shrink-0 flex-col border-l border-slate-200 bg-white dark:border-zinc-800/80 dark:bg-zinc-900/60">
          <div className="border-b border-slate-200 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-slate-500">Playlist · A–Z</div>
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {sortedQueue.map((item, index) => {
              const active = item.id === file.id
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onPlayFile(item)}
                    className={['flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition', active ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-50'].join(' ')}
                  >
                    <span className="w-5 shrink-0 text-right text-[11px] tabular-nums text-slate-400">{index + 1}</span>
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    {active ? <Play className="h-3.5 w-3.5 shrink-0 fill-current" /> : null}
                  </button>
                </li>
              )
            })}
          </ul>
        </aside>
      ) : null}
    </div>
  )
}
