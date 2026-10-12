import { MoreVertical, Folder } from 'lucide-react'
import type { MouseEvent } from 'react'
import { cn } from '@/lib/utils'
import type { FolderItem } from '@/data/drive-data'

/**
 * Google Drive / macOS-Finder style folder cards. Folders flow in a fully
 * responsive 1→5 column grid that scales naturally across wide displays, with
 * a glass card body, a soft amber-tinted folder badge, and consistent
 * icon + name + subtext + hover-reveal action anatomy.
 */
export function FolderGrid({
  items,
  onFolderMenu,
  onFolderOpen,
  onDropItem,
}: {
  items: FolderItem[]
  onFolderMenu?: (event: MouseEvent<HTMLElement>, folder: FolderItem) => void
  onFolderOpen?: (folder: FolderItem) => void
  onDropItem?: (fileId: string, folderId: string) => void
}) {
  return (
    <div className="mb-7 grid w-full grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3.5">
      {items.map((folder) => (
        <div
          key={folder.id || folder.name}
          role="button"
          tabIndex={0}
          onClick={() => onFolderOpen?.(folder)}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onFolderOpen?.(folder) } }}
          onContextMenu={(event) => onFolderMenu?.(event, folder)}
          onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }}
          onDragEnter={(event) => { event.currentTarget.classList.add('border-amber-500/50') }}
          onDragLeave={(event) => { event.currentTarget.classList.remove('border-amber-500/50') }}
          onDrop={(event) => {
            event.preventDefault()
            event.currentTarget.classList.remove('border-amber-500/50')
            const fileId = event.dataTransfer.getData('text/plain')
            if (fileId && folder.id) onDropItem?.(fileId, folder.id)
          }}
          className={cn(
            'group flex cursor-pointer items-center gap-3.5 rounded-2xl border border-white/[0.07] bg-zinc-900/40 p-3 transition-all duration-200 hover:-translate-y-0.5 hover:border-amber-500/30 hover:bg-zinc-900/80 hover:shadow-lg dark:border-white/[0.07] dark:bg-zinc-900/40 dark:hover:border-amber-500/30 dark:hover:bg-zinc-900/80'
          )}
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-500/20 bg-amber-500/10 text-amber-400 transition-transform group-hover:scale-105">
            <Folder className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold text-zinc-200 transition-colors group-hover:text-amber-300" title={folder.name}>{folder.name}</p>
            <p className="mt-0.5 font-mono text-[11px] text-zinc-500">{folder.itemCount ?? 0} items</p>
          </div>
          <button
            type="button"
            className="ml-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 opacity-0 transition-opacity hover:bg-zinc-100 hover:text-zinc-700 group-hover:opacity-100 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            onClick={(event) => { event.stopPropagation(); onFolderMenu?.(event, folder) }}
            aria-label={`Open ${folder.name} menu`}
          >
            <MoreVertical className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  )
}
