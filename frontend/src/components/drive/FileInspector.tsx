import { useEffect, useState } from 'react'
import { Download, FileText, Folder, HardDrive, Move, Pencil, Trash2, X } from 'lucide-react'
import type { FileItem } from '@/data/drive-data'
import { formatBytes, formatDate } from '@/lib/api'
import { cn } from '@/lib/utils'
import { getCachedThumb, runThumbTask, setCachedThumb } from '@/lib/thumbQueue'

/** Format-badge label (MP4, PDF, …) derived from the file kind/mime. */
function formatBadgeLabel(file: FileItem): string {
  if (file.mimeType) {
    const subtype = file.mimeType.split('/')[1]
    if (subtype) return subtype.replace(/^vnd\.|^x-/, '').replace(/\+.*$/, '').toUpperCase().slice(0, 6)
  }
  if (file.kind === 'video') return 'MP4'
  if (file.kind === 'image') return 'IMG'
  if (file.kind === 'pdf') return 'PDF'
  return 'FILE'
}

/**
 * Mini square preview stage. Streams the token-protected preview URL and, for
 * video, extracts a poster frame; for images shows the decoded thumbnail. Reuses
 * the shared thumbnail cache so a poster already extracted by the grid is shown
 * instantly. Falls back to a flat type icon on any failure.
 */
function MiniPreview({ file, resolveThumbUrl }: { file: FileItem; resolveThumbUrl?: (f: FileItem) => Promise<string> }) {
  const [src, setSrc] = useState<string>(getCachedThumb(file.id) || file.thumbnailUrl || '')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    let objectUrl = ''
    const cached = getCachedThumb(file.id)
    if (cached) { setSrc(cached); return }
    if (file.thumbnailUrl) { setSrc(file.thumbnailUrl); return }
    if (!resolveThumbUrl) { setFailed(true); return }

    runThumbTask(async () => {
      const url = await resolveThumbUrl(file)
      const response = await fetch(url)
      const blob = await response.blob()
      if (cancelled) return
      objectUrl = URL.createObjectURL(blob)

      if (file.kind === 'video') {
        const video = document.createElement('video')
        video.preload = 'metadata'
        video.muted = true
        video.crossOrigin = 'anonymous'
        video.src = objectUrl
        const draw = () => {
          if (cancelled) return
          const canvas = document.createElement('canvas')
          canvas.width = video.videoWidth || 320
          canvas.height = video.videoHeight || 180
          const ctx = canvas.getContext('2d')
          if (!ctx) { setFailed(true); return }
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          const dataUrl = canvas.toDataURL('image/jpeg', 0.7)
          setCachedThumb(file.id, dataUrl)
          if (!cancelled) setSrc(dataUrl)
        }
        video.onloadeddata = () => { try { video.currentTime = Math.min(1.0, (video.duration || 2) / 2) } catch { draw() } }
        video.onseeked = draw
        video.onerror = () => { if (!cancelled) setFailed(true) }
        video.load()
      } else {
        setCachedThumb(file.id, objectUrl)
        if (!cancelled) setSrc(objectUrl)
      }
    }).catch(() => { if (!cancelled) setFailed(true) })

    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [file, resolveThumbUrl])

  if (src && !failed) {
    return <img src={src} alt={file.name} className="h-full w-full object-cover" />
  }
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-zinc-800/60 text-zinc-400">
      <FileText className="h-8 w-8" strokeWidth={1.5} />
      <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">No preview</span>
    </div>
  )
}


function MetadataRow({ icon: Icon, label, value }: { icon: typeof Folder; label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-white/[0.04] py-2.5 last:border-b-0">
      <span className="flex shrink-0 items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
        <Icon className="h-3.5 w-3.5 text-zinc-600" />
        {label}
      </span>
      <span className="min-w-0 break-words text-right text-xs font-medium text-zinc-200">{value || '—'}</span>
    </div>
  )
}

export type FileInspectorProps = {
  file: FileItem | null
  open: boolean
  resolveThumbUrl?: (file: FileItem) => Promise<string>
  onClose: () => void
  onDownload: (file: FileItem) => void
  onMove: (file: FileItem) => void
  onRename: (file: FileItem) => void
  onDelete: (file: FileItem) => void
}

/**
 * Right Inspector (File Details) panel. Rendered inline as a full-height column
 * beside the browsing stage on wide screens (the parent reserves its width and
 * only mounts it when a file is selected). Shows a mini preview stage, key
 * metadata table, and a direct actions bar (Download / Move / Rename / Trash).
 */
export function FileInspector({ file, open, resolveThumbUrl, onClose, onDownload, onMove, onRename, onDelete }: FileInspectorProps) {
  return (
    <div
      className={cn(
        'flex h-full w-full flex-col bg-[#0e0f16]/80',
        open && file ? '' : 'pointer-events-none'
      )}
      aria-hidden={!open || !file}
    >
      {file ? (
        <div className="flex h-full min-h-0 flex-col">
          {/* Header: close button, format badge, filename with tooltip. */}
          <div className="flex items-start justify-between gap-3 border-b border-white/[0.08] p-4">
            <div className="min-w-0 flex-1">
              <span className="inline-flex rounded-md border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase text-blue-300">
                {formatBadgeLabel(file)}
              </span>
              <h2 className="mt-2 truncate text-sm font-semibold text-zinc-100" title={file.name}>{file.name}</h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close inspector"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Mini Preview Stage: square aspect-ratio preview. */}
          <div className="p-4">
            <div className="aspect-square w-full overflow-hidden rounded-xl border border-white/[0.06] bg-zinc-800/40">
              <MiniPreview file={file} resolveThumbUrl={resolveThumbUrl} />
            </div>
          </div>

          {/* Key Metadata Table */}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">
            <MetadataRow icon={HardDrive} label="Size" value={file.sizeBytes ? formatBytes(file.sizeBytes) : file.size} />
            <MetadataRow icon={FileText} label="Type" value={file.mimeType ?? file.kind} />
            <MetadataRow icon={HardDrive} label="Storage" value={file.accountEmail ? `${file.accountProvider ?? 'Google Drive'} · ${file.accountEmail}` : (file.accountProvider ?? 'Google Drive')} />
            <MetadataRow icon={Folder} label="Modified" value={file.createdAt ? formatDate(file.createdAt) : file.date} />
            <MetadataRow icon={Folder} label="Folder" value={file.folderName ? file.folderName : 'All Files'} />
          </div>

          {/* Direct Actions Bar */}
          <div className="grid grid-cols-2 gap-2 border-t border-white/[0.06] p-4">
            <button
              type="button"
              onClick={() => onDownload(file)}
              className="flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-3 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-blue-500"
            >
              <Download className="h-3.5 w-3.5" />Download
            </button>
            <button
              type="button"
              onClick={() => onMove(file)}
              className="flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-xs font-semibold text-zinc-200 transition-colors hover:bg-white/10"
            >
              <Move className="h-3.5 w-3.5" />Move
            </button>
            <button
              type="button"
              onClick={() => onRename(file)}
              className="flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-xs font-semibold text-zinc-200 transition-colors hover:bg-white/10"
            >
              <Pencil className="h-3.5 w-3.5" />Rename
            </button>
            <button
              type="button"
              onClick={() => onDelete(file)}
              className="flex items-center justify-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-xs font-semibold text-red-400 transition-colors hover:bg-red-500/20"
            >
              <Trash2 className="h-3.5 w-3.5" />Move to Trash
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
