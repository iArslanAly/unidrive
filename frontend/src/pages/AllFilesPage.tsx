import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type MouseEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowDown, ArrowUp, ArrowUpDown, CheckCircle, ChevronRight, ClipboardPaste, CloudOff, CloudUpload, Download, Film, FileText, Folder, FolderInput, FolderPlus, Image as ImageIcon, Info, LayoutGrid, List, Loader2, Music, Plus, RefreshCw, Trash2, Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { DummyModal } from '@/components/drive/DummyModal'
import { EmptyAreaContextMenu } from '@/components/drive/EmptyAreaContextMenu'
import { FileContextMenu } from '@/components/drive/FileContextMenu'
import { FileDetailsDrawer } from '@/components/drive/FileDetailsDrawer'
import { FileGrid } from '@/components/drive/FileGrid'
import { FileInspector } from '@/components/drive/FileInspector'
import { FileTable } from '@/components/drive/FileTable'
import { FolderContextMenu } from '@/components/drive/FolderContextMenu'
import { FolderGrid } from '@/components/drive/FolderGrid'
import { defaultFolderColor, defaultFolderIconUrl, folderColorOptions, folderIconOptions, normalizeFolderColor } from '@/components/drive/FolderVisual'
import { Input } from '@/components/ui/input'
import { API_URL, apiFetch, formatBytes, formatDate } from '@/lib/api'
import { getAccessToken } from '@/lib/auth'
import { cn } from '@/lib/utils'
import { UniversalStage } from '@/components/drive/UniversalStage'
import type { FileItem, FolderItem } from '@/data/drive-data'
import { useUpload } from '@/context/UploadContext'
import { useDriveLayoutActions } from '@/context/DriveLayoutContext'
import { getCachedFiles, setCachedFiles, getCachedFolders, setCachedFolders, invalidateVaultCache } from '@/lib/vaultCache'

type BackendFile = { id: string; name: string; mimeType: string; sizeBytes: string; createdAt: string; thumbnailUrl?: string | null; providerFileId?: string | null; folderId?: string | null; connectedAccount?: { email: string; provider: string }; folder?: { id: string; name: string } | null }
type BackendFolder = { id: string; name: string; color: string; iconUrl?: string | null; parentId?: string | null; providerFolderId?: string | null; updatedAt: string; itemCount?: number }
type ConnectedAccount = { id: string; provider: string; email: string; displayName?: string | null; status: string }
type StorageSummary = { totalBytes: string; usedBytes: string; availableBytes: string }

type FileViewMode = 'list' | 'grid'

type SortField = 'name' | 'updatedAt' | 'sizeBytes' | 'mimeType'
type SortDirection = 'asc' | 'desc'
type TypeFilter = 'all' | 'video' | 'audio' | 'document' | 'image'

const sortFieldLabel: Record<SortField, string> = {
  name: 'Name',
  updatedAt: 'Date Modified',
  sizeBytes: 'File Size',
  mimeType: 'File Type',
}

const fileViewStorageKey = 'unidrive_view_mode'

function getStoredFileViewMode(): FileViewMode {
  const stored = localStorage.getItem(fileViewStorageKey)
  return stored === 'grid' || stored === 'list' ? stored : 'list'
}

function mimeToKind(mimeType: string): FileItem['kind'] {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.includes('pdf')) return 'pdf'
  return 'doc'
}

function providerLabel(provider: string | undefined) {
  if (provider === 's3') return 'S3 Storage'
  return 'Google Drive'
}

function mapFile(file: BackendFile): FileItem {
  return { id: file.id, name: file.name, mimeType: file.mimeType, sizeBytes: file.sizeBytes, createdAt: file.createdAt, thumbnailUrl: file.thumbnailUrl ?? null, providerFileId: file.providerFileId ?? null, accountEmail: file.connectedAccount?.email, accountProvider: providerLabel(file.connectedAccount?.provider), date: formatDate(file.createdAt), size: formatBytes(file.sizeBytes), access: file.connectedAccount?.email ?? providerLabel(file.connectedAccount?.provider), kind: mimeToKind(file.mimeType), shared: 1, folderId: file.folderId, folderName: file.folder?.name }
}

function mapFolder(folder: BackendFolder): FolderItem {
  return { id: folder.id, name: folder.name, color: folder.color, iconUrl: folder.iconUrl, parentId: folder.parentId, providerFolderId: folder.providerFolderId, itemCount: folder.itemCount, updated: `Updated ${formatDate(folder.updatedAt)}` }
}



function FolderAppearanceFields({ color, iconUrl, onColorChange, onIconChange }: { color: string; iconUrl: string; onColorChange: (color: string) => void; onIconChange: (iconUrl: string) => void }) {
  const normalizedColor = normalizeFolderColor(color)
  return (
    <div className="grid gap-4">
      <label className="grid gap-2 text-sm font-semibold">Folder Color<Input type="color" value={normalizedColor} onChange={(event) => onColorChange(event.target.value)} className="h-12 p-1" /></label>
      <div className="flex flex-wrap gap-2">{folderColorOptions.map((option) => <button key={option} type="button" onClick={() => onColorChange(option)} className={normalizedColor === option ? 'h-8 w-8 rounded-lg border-2 border-blue-600' : 'h-8 w-8 rounded-lg border border-slate-200'} style={{ backgroundColor: option }} aria-label={`Use ${option} folder color`} />)}</div>
      <div className="grid gap-2 text-sm font-semibold"><span>Folder Icon</span><div className="grid grid-cols-4 gap-2 sm:grid-cols-8">{folderIconOptions.map((option) => <button key={option.url} type="button" onClick={() => onIconChange(option.url)} className={iconUrl === option.url ? 'flex h-12 items-center justify-center rounded-xl border-2 border-blue-600 bg-blue-50 p-2' : 'flex h-12 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 p-2 hover:bg-slate-100'} title={option.label} aria-label={`Use ${option.label} icon`}><img src={`${option.url}?color=${encodeURIComponent(normalizedColor)}`} alt="" className="h-6 w-6" /></button>)}</div></div>
    </div>
  )
}

export function AllFilesPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const activeFolderId = searchParams.get('folderId')
  const searchQuery = searchParams.get('q')?.trim() ?? ''
  const [uploadOpen, setUploadOpen] = useState(false)
  const [folderOpen, setFolderOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [folderRenameOpen, setFolderRenameOpen] = useState(false)
  const [folderDeleteOpen, setFolderDeleteOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [shareUrl, setShareUrl] = useState('')
  const [copiedShareLink, setCopiedShareLink] = useState(false)
  const [previewUrl, setPreviewUrl] = useState('')
  const [previewError, setPreviewError] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [files, setFiles] = useState<FileItem[]>([])
  const [folders, setFolders] = useState<FolderItem[]>([])
  const [allFolders, setAllFolders] = useState<FolderItem[]>([])
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [selectedFolderId, setSelectedFolderId] = useState('')
  const [isUploadDragging, setIsUploadDragging] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [folderColor, setFolderColor] = useState(defaultFolderColor)
  const [folderIconUrl, setFolderIconUrl] = useState(defaultFolderIconUrl)
  const [renameValue, setRenameValue] = useState('')
  const [folderRenameValue, setFolderRenameValue] = useState('')
  const [folderRenameColor, setFolderRenameColor] = useState(defaultFolderColor)
  const [folderRenameIconUrl, setFolderRenameIconUrl] = useState(defaultFolderIconUrl)
  const [activeFile, setActiveFile] = useState<FileItem | null>(null)
  const [activeFolderForMenu, setActiveFolderForMenu] = useState<FolderItem | null>(null)
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set())
  const [cutFolder, setCutFolder] = useState<FolderItem | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: FileItem | null }>({ x: 0, y: 0, file: null })
  const [folderContextMenu, setFolderContextMenu] = useState<{ x: number; y: number; folder: FolderItem | null }>({ x: 0, y: 0, folder: null })
  const [emptyContextMenu, setEmptyContextMenu] = useState<{ x: number; y: number; open: boolean }>({ x: 0, y: 0, open: false })
  const [message, setMessage] = useState('')
  const [loadError, setLoadError] = useState('')
  const [reloadNonce, setReloadNonce] = useState(0)
  const [gdrivePublicUrl, setGdrivePublicUrl] = useState('')
  const [makingPublic, setMakingPublic] = useState(false)
  const [loading, setLoading] = useState(false)
  const [syncingDrive, setSyncingDrive] = useState(false)
  const [fileViewMode, setFileViewMode] = useState<FileViewMode>(getStoredFileViewMode)
  const [sortField, setSortField] = useState<SortField>('updatedAt')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const [inspectorFileId, setInspectorFileId] = useState<string | null>(null)
  const { uploadFiles } = useUpload()
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('viewer')
  const [inviteTargetType, setInviteTargetType] = useState<'file' | 'folder'>('file')
  const [inviteTargetId, setInviteTargetId] = useState('')
  const [inviteMessage, setInviteMessage] = useState('')
  const [inviting, setInviting] = useState(false)
  const [isDraggingFiles, setIsDraggingFiles] = useState(false)
  const { setHeaderActions } = useDriveLayoutActions()
  const [connectedAccounts, setConnectedAccounts] = useState<ConnectedAccount[]>([])
  const [storageSummary, setStorageSummary] = useState<StorageSummary | null>(null)
  const [selectedTargetAccountId, setSelectedTargetAccountId] = useState('')

  async function loadFiles() {
    const params = new URLSearchParams()
    // Strict folder scoping: root view requests folderId=null (root rows only)
    // and folder view requests that folder's id — never omit folderId, which
    // would return files from every folder.
    params.set('folderId', activeFolderId ?? 'null')
    if (searchQuery) params.set('q', searchQuery)

    // Add advanced search filters
    const kind = searchParams.get('kind')
    const accountId = searchParams.get('accountId')
    const minSize = searchParams.get('minSize')
    const maxSize = searchParams.get('maxSize')
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')

    if (kind) params.set('kind', kind)
    if (accountId) params.set('accountId', accountId)
    if (minSize) params.set('minSize', minSize)
    if (maxSize) params.set('maxSize', maxSize)
    if (startDate) params.set('startDate', startDate)
    if (endDate) params.set('endDate', endDate)

    const query = params.toString()
    const cacheKey = query || 'folderId=null'
    // SWR: paint cached rows instantly (0ms, no flash), then revalidate. The cache
    // stores fully-mapped FileItems (dates already formatted via the safe
    // formatDate), so a cache hit needs no re-mapping and preserves dates verbatim.
    const cached = getCachedFiles<FileItem>(cacheKey)
    if (cached) setFiles(cached.files)
    const path = query ? `/files?${query}` : '/files'
    const data = await apiFetch<{ files: BackendFile[] }>(path)
    const mapped = data.files.map(mapFile)
    setCachedFiles(cacheKey, { files: mapped })
    setFiles(mapped)
  }

  async function loadFolders() {
    const visiblePath = activeFolderId ? `/folders?parentId=${activeFolderId}` : '/folders'
    const visibleKey = activeFolderId ? `parentId=${activeFolderId}` : 'root'
    const cachedVisible = getCachedFolders<FolderItem>(visibleKey)
    if (cachedVisible) setFolders(cachedVisible.folders)
    const [visibleData, allData] = await Promise.all([
      apiFetch<{ folders: BackendFolder[] }>(visiblePath),
      apiFetch<{ folders: BackendFolder[] }>('/folders?all=1'),
    ])
    const mappedVisible = visibleData.folders.map(mapFolder)
    setCachedFolders(visibleKey, { folders: mappedVisible })
    setFolders(mappedVisible)
    setAllFolders(allData.folders.map(mapFolder))
  }

  async function loadAll() {
    await Promise.all([loadFiles(), loadFolders()])
  }

  async function handleDropItem(fileId: string, targetFolderId: string) {
    const fileIds = selectedFileIds.has(fileId) ? Array.from(selectedFileIds) : [fileId]
    setLoading(true)
    setMessage('')
    try {
      await apiFetch('/files/batch', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileIds, folderId: targetFolderId })
      })
      setMessage(`Successfully moved ${fileIds.length} item(s).`)
      loadAll().catch(() => undefined)
      setSelectedFileIds(new Set())
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to move items')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadAll()
      .then(() => setLoadError(''))
      .catch((error) => setLoadError(error instanceof Error ? error.message : 'Failed to load files'))
    setSelectedFileIds(new Set())
  }, [activeFolderId, searchQuery, reloadNonce])

  useEffect(() => {
    async function loadConnectedDrives() {
      try {
        const [accountsData, summaryData] = await Promise.all([
          apiFetch<{ accounts: ConnectedAccount[] }>('/connected-accounts'),
          apiFetch<StorageSummary>('/storage/summary'),
        ])
        setConnectedAccounts(accountsData.accounts || [])
        setStorageSummary(summaryData)
      } catch (error) {
        console.error('Failed to load connected accounts:', error)
      }
    }
    loadConnectedDrives()
    // Keep the dropzone CTA reactive: quota syncs and OAuth connects dispatch
    // this event, so the empty state flips to an Upload action without a reload.
    window.addEventListener('9drive:storage-changed', loadConnectedDrives)
    return () => window.removeEventListener('9drive:storage-changed', loadConnectedDrives)
  }, [])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setContextMenu({ x: 0, y: 0, file: null })
      if (event.key === 'Escape') setFolderContextMenu({ x: 0, y: 0, folder: null })
      if (event.key === 'Escape') setEmptyContextMenu({ x: 0, y: 0, open: false })
      if (event.key === 'Escape') setSortMenuOpen(false)
      if (event.key === 'Escape') setInspectorFileId(null)
      if (event.ctrlKey && event.key.toLowerCase() === 'x' && activeFolderForMenu) {
        event.preventDefault()
        cutSelectedFolder(activeFolderForMenu)
      }
      if (event.ctrlKey && event.key.toLowerCase() === 'v' && cutFolder) {
        event.preventDefault()
        pasteFolder().catch((error) => setMessage(error instanceof Error ? error.message : 'Failed to paste folder'))
      }
    }

    function onOpenMoveShortcut(e: Event) {
      const file = (e as CustomEvent).detail as FileItem
      setActiveFile(file)
      setSelectedFolderId(file.folderId || '')
      setMoveOpen(true)
    }

    window.addEventListener('keydown', onKey)
    window.addEventListener('9drive:open-move-modal', onOpenMoveShortcut)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('9drive:open-move-modal', onOpenMoveShortcut)
    }
  }, [activeFolderForMenu, cutFolder, activeFolderId])

  async function createFolder(event: FormEvent) {
    event.preventDefault()
    await apiFetch('/folders', { method: 'POST', body: JSON.stringify({ name: folderName, color: folderColor, iconUrl: folderIconUrl, parentId: activeFolderId ?? null }) })
    setFolderName('')
    setFolderColor(defaultFolderColor)
    setFolderIconUrl(defaultFolderIconUrl)
    setFolderOpen(false)
    invalidateVaultCache()
    await loadFolders()
  }

  async function uploadFile(event: FormEvent) {
    event.preventDefault()
    if (selectedFiles.length === 0) return
    setLoading(true)
    setMessage('')

    const uploadingFiles = [...selectedFiles]
    const targetFolderId = activeFolderId || selectedFolderId
    const targetAccountId = selectedTargetAccountId || null

    setSelectedFiles([])
    setSelectedFolderId('')
    setSelectedTargetAccountId('')
    setUploadOpen(false)

    try {
      await uploadFiles(uploadingFiles, targetFolderId, targetAccountId)
    } catch (err) {
      console.error('Upload initiation failed:', err)
    } finally {
      setLoading(false)
    }
  }


  async function syncGoogleDrive() {
    setSyncingDrive(true)
    setMessage('')
    try {
      const response = await apiFetch<{ results: { created: number; updated: number; deleted: number }[] }>('/files/sync-google', { method: 'POST', body: JSON.stringify({}) })

      let created = 0, updated = 0, deleted = 0
      for (const res of response.results) {
        created += res.created
        updated += res.updated
        deleted += res.deleted
      }
      const accounts = response.results.length

      setMessage(`Google Drive synced. ${created} added, ${updated} updated, ${deleted} removed across ${accounts} account${accounts === 1 ? '' : 's'}.`)
      invalidateVaultCache()
      await loadAll()
      window.dispatchEvent(new Event('9drive:storage-changed'))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to sync Google Drive')
    } finally {
      setSyncingDrive(false)
    }
  }

  function selectUploadFiles(files: FileList | File[] | null | undefined) {
    if (!files) return
    const nextFiles = Array.from(files)
    if (nextFiles.length === 0) return
    setSelectedFiles(nextFiles)
  }

  function removeUploadFile(index: number) {
    setSelectedFiles((files) => files.filter((_, fileIndex) => fileIndex !== index))
  }

  function handleUploadDrag(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault()
    event.stopPropagation()
    if (event.type === 'dragenter' || event.type === 'dragover') setIsUploadDragging(true)
    if (event.type === 'dragleave' || event.type === 'drop') setIsUploadDragging(false)
    if (event.type === 'drop') selectUploadFiles(event.dataTransfer.files)
  }



  function openContext(event: MouseEvent<HTMLElement>, file: FileItem) {
    event.preventDefault()
    event.stopPropagation()
    setActiveFile(file)
    setContextMenu({ x: event.clientX, y: event.clientY, file })
  }

  function toggleFileSelection(file: FileItem) {
    if (!file.id) return
    setSelectedFileIds((current) => {
      const next = new Set(current)
      if (next.has(file.id!)) next.delete(file.id!)
      else next.add(file.id!)
      return next
    })
  }

  function toggleAllVisibleFiles() {
    const visibleIds = files.map((file) => file.id).filter(Boolean) as string[]
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedFileIds.has(id))
    setSelectedFileIds(allSelected ? new Set() : new Set(visibleIds))
  }

  function clearSelection() {
    setSelectedFileIds(new Set())
  }

  function changeFileViewMode(mode: FileViewMode) {
    setFileViewMode(mode)
    localStorage.setItem(fileViewStorageKey, mode)
  }

  function openFolderMenu(event: MouseEvent<HTMLElement>, folder: FolderItem) {
    event.preventDefault()
    event.stopPropagation()
    setActiveFolderForMenu(folder)
    setFolderContextMenu({ x: event.clientX, y: event.clientY, folder })
  }

  function openFolder(folder: FolderItem) {
    if (!folder.id) return
    setSearchParams(searchQuery ? { folderId: folder.id, q: searchQuery } : { folderId: folder.id })
  }

  function openFolderById(folderId: string) {
    setSearchParams(searchQuery ? { folderId, q: searchQuery } : { folderId })
  }

  function openEmptyContextMenu(event: MouseEvent<HTMLElement>) {
    event.preventDefault()
    setEmptyContextMenu({ x: event.clientX, y: event.clientY, open: true })
  }

  function closeFolder() {
    setSearchParams(searchQuery ? { q: searchQuery } : {})
  }

  const resolvePreviewUrl = useCallback(async (file: FileItem) => {
    const data = await apiFetch<{ path?: string; url: string }>(`/files/${file.id}/preview-token`, { method: 'POST' })
    const previewPath = data.path ?? new URL(data.url).pathname
    return `${API_URL}${previewPath}`
  }, [])

  async function viewFile() {
    if (!activeFile?.id) return
    await playFromStage(activeFile)
  }

  const playFromStage = useCallback(async (file: FileItem) => {
    setPreviewUrl('')
    setPreviewError('')
    setPreviewLoading(true)
    setPreviewOpen(true)
    setContextMenu({ x: 0, y: 0, file: null })
    setActiveFile(file)
    try {
      setPreviewUrl(await resolvePreviewUrl(file))
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : 'Failed to load preview')
    } finally {
      setPreviewLoading(false)
    }
  }, [resolvePreviewUrl])

  /** Double-click in grid/list opens the Universal Stage directly for this file. */
  function openStage(file: FileItem) {
    if (!file.id) return
    playFromStage(file).catch(() => undefined)
  }

  /** Single-click on a file card: select it and slide in the Right Inspector. */
  function selectFileForInspector(file: FileItem) {
    if (!file.id) return
    setInspectorFileId(file.id)
    setActiveFile(file)
  }

  function closeInspector() {
    setInspectorFileId(null)
  }

  function inspectorDownload(file: FileItem) {
    setActiveFile(file)
    downloadFile(file)
  }

  function inspectorMove(file: FileItem) {
    setActiveFile(file)
    setSelectedFolderId(file.folderId || '')
    setMoveOpen(true)
  }

  function inspectorRename(file: FileItem) {
    setActiveFile(file)
    setRenameValue(file.name)
    setRenameOpen(true)
  }

  function inspectorDelete(file: FileItem) {
    setActiveFile(file)
    setDeleteOpen(true)
  }

  function handleDropzoneDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    event.stopPropagation()
    setIsDraggingFiles(false)
    const dropped = Array.from(event.dataTransfer.files ?? [])
    if (dropped.length === 0) return
    uploadFiles(dropped, activeFolderId ?? null).catch((error) => setMessage(error instanceof Error ? error.message : 'Upload failed'))
  }

  async function downloadFile(targetFile?: FileItem) {
    const target = targetFile ?? activeFile
    if (!target?.id) return
    const response = await fetch(`${API_URL}/files/${target.id}/download`, { headers: { Authorization: `Bearer ${getAccessToken()}` } })
    if (!response.ok) throw new Error('Download failed')
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = target.name
    link.click()
    URL.revokeObjectURL(url)
    setContextMenu({ x: 0, y: 0, file: null })
  }

  async function downloadBatchAsZip() {
    const selectedIds = [...selectedFileIds]
    if (selectedIds.length === 0) return
    setLoading(true)
    setMessage('')
    try {
      const response = await fetch(`${API_URL}/files/batch-download`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getAccessToken()}`
        },
        body: JSON.stringify({ fileIds: selectedIds })
      })
      if (!response.ok) throw new Error('Failed to download ZIP file')
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'unidrive-download.zip'
      link.click()
      URL.revokeObjectURL(url)
      clearSelection()
      setMessage('Batch download complete.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Batch download failed')
    } finally {
      setLoading(false)
    }
  }


  async function renameFile(event: FormEvent) {
    event.preventDefault()
    if (!activeFile?.id) return
    await apiFetch(`/files/${activeFile.id}`, { method: 'PATCH', body: JSON.stringify({ name: renameValue }) })
    setRenameOpen(false)
    invalidateVaultCache()
    await loadFiles()
  }

  async function moveFile(event: FormEvent) {
    event.preventDefault()
    const selectedIds = [...selectedFileIds]
    if (selectedIds.length > 0) await apiFetch('/files/batch', { method: 'PATCH', body: JSON.stringify({ fileIds: selectedIds, folderId: selectedFolderId || null }) })
    else if (activeFile?.id) await apiFetch(`/files/${activeFile.id}`, { method: 'PATCH', body: JSON.stringify({ folderId: selectedFolderId || null }) })
    else return
    setMoveOpen(false)
    setSelectedFolderId('')
    clearSelection()
    invalidateVaultCache()
    await loadFiles()
  }

  async function deleteFile() {
    const selectedIds = [...selectedFileIds]
    if (selectedIds.length > 0) await apiFetch('/files/batch', { method: 'DELETE', body: JSON.stringify({ fileIds: selectedIds }) })
    else if (activeFile?.id) await apiFetch(`/files/${activeFile.id}`, { method: 'DELETE' })
    else return
    setDeleteOpen(false)
    clearSelection()
    invalidateVaultCache()
    await loadFiles()
    window.dispatchEvent(new Event('9drive:storage-changed'))
  }

  async function shareFile() {
    if (!activeFile?.id) return
    const data = await apiFetch<{ url: string }>(`/files/${activeFile.id}/share`, { method: 'POST' })
    setShareUrl(data.url)
    setCopiedShareLink(false)
    setGdrivePublicUrl('')
    setMakingPublic(false)
    setShareOpen(true)
    setContextMenu({ x: 0, y: 0, file: null })
  }

  async function copyShareLinkDirect() {
    if (!activeFile?.id) return
    try {
      const data = await apiFetch<{ url: string | null }>(`/files/${activeFile.id}/view-url`)
      if (data.url) {
        await navigator.clipboard.writeText(data.url)
        setMessage('Google Drive link copied to clipboard!')
        setTimeout(() => setMessage(''), 2500)
      } else {
        const shareData = await apiFetch<{ url: string }>(`/files/${activeFile.id}/share`, { method: 'POST' })
        await navigator.clipboard.writeText(shareData.url)
        setMessage('Share link copied to clipboard!')
        setTimeout(() => setMessage(''), 2500)
      }
    } catch (err: any) {
      setMessage('Failed to copy link: ' + (err.message || err))
      setTimeout(() => setMessage(''), 2500)
    }
    setContextMenu({ x: 0, y: 0, file: null })
  }

  async function inviteToFile() {
    if (!activeFile?.id) return
    setInviteTargetType('file')
    setInviteTargetId(activeFile.id)
    setInviteOpen(true)
    setContextMenu({ x: 0, y: 0, file: null })
  }

  async function inviteToFolder() {
    if (!activeFolderForMenu?.id) return
    setInviteTargetType('folder')
    setInviteTargetId(activeFolderForMenu.id)
    setInviteOpen(true)
    setFolderContextMenu({ x: 0, y: 0, folder: null })
  }

  async function copyFolderLink() {
    if (!activeFolderForMenu?.id) return
    let url = `${window.location.origin}/all-files?folderId=${activeFolderForMenu.id}`
    if (activeFolderForMenu.providerFolderId) {
      url = `https://drive.google.com/open?id=${activeFolderForMenu.providerFolderId}`
    }
    await navigator.clipboard.writeText(url)
    setMessage('Folder link copied to clipboard!')
    setTimeout(() => setMessage(''), 2500)
    setFolderContextMenu({ x: 0, y: 0, folder: null })
  }

  async function sendInvite(event: FormEvent) {
    event.preventDefault()
    if (!inviteTargetId) return
    setInviting(true)
    setInviteMessage('')
    try {
      await apiFetch('/invites', { method: 'POST', body: JSON.stringify({ email: inviteEmail, role: inviteRole, targetType: inviteTargetType, targetId: inviteTargetId }) })
      setInviteEmail('')
      setInviteRole('viewer')
      setInviteMessage('Invite saved. Member will appear in Shared.')
      window.dispatchEvent(new Event('9drive:invites-changed'))
    } catch (error) {
      setInviteMessage(error instanceof Error ? error.message : 'Failed to send invite')
    } finally {
      setInviting(false)
    }
  }

  async function copyShareLink() {
    await navigator.clipboard.writeText(shareUrl)
    setCopiedShareLink(true)
    window.setTimeout(() => setCopiedShareLink(false), 1600)
  }

  async function renameFolder(event: FormEvent) {
    event.preventDefault()
    if (!activeFolderForMenu?.id) return
    await apiFetch(`/folders/${activeFolderForMenu.id}`, { method: 'PATCH', body: JSON.stringify({ name: folderRenameValue, color: folderRenameColor, iconUrl: folderRenameIconUrl }) })
    setFolderRenameOpen(false)
    invalidateVaultCache()
    await loadFolders()
  }

  async function deleteFolder() {
    if (!activeFolderForMenu?.id) return
    await apiFetch(`/folders/${activeFolderForMenu.id}`, { method: 'DELETE' })
    setFolderDeleteOpen(false)
    invalidateVaultCache()
    await loadFolders()
  }

  function cutSelectedFolder(folder: FolderItem | null) {
    if (!folder?.id) return
    setCutFolder(folder)
    setFolderContextMenu({ x: 0, y: 0, folder: null })
    setMessage(`Folder "${folder.name}" ready to move. Open target folder and press Ctrl+V.`)
  }

  async function pasteFolder() {
    if (!cutFolder?.id) return
    await apiFetch(`/folders/${cutFolder.id}`, { method: 'PATCH', body: JSON.stringify({ parentId: activeFolderId ?? null }) })
    setMessage(`Folder "${cutFolder.name}" moved.`)
    setCutFolder(null)
    invalidateVaultCache()
    await loadFolders()
  }

  function closePreview() {
    setPreviewUrl('')
    setPreviewError('')
    setPreviewLoading(false)
    setPreviewOpen(false)
  }

  useEffect(() => {
    function handleUploadCompleted() {
      invalidateVaultCache()
      loadAll().catch(() => undefined)
    }
    window.addEventListener('9drive:upload-completed', handleUploadCompleted)
    return () => window.removeEventListener('9drive:upload-completed', handleUploadCompleted)
  }, [activeFolderId])

  useEffect(() => {
    setHeaderActions(
      <div className="flex items-center gap-1.5 sm:gap-2">
        <Button size="sm" title="Upload files" onClick={() => setUploadOpen(true)}>
          <Upload className="h-3.5 w-3.5" />Upload
        </Button>
        <Button size="sm" variant="ghost" className="px-2 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 sm:px-3 md:px-4 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100" title="New Folder" aria-label="New Folder" onClick={() => setFolderOpen(true)}>
          <FolderPlus className="h-4 w-4" />
          <span className="hidden md:inline">New Folder</span>
        </Button>
        <Button size="sm" variant="ghost" className="px-2 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 sm:px-3 md:px-4 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100" disabled={syncingDrive} title={syncingDrive ? 'Syncing...' : 'Sync with Google Drive'} aria-label={syncingDrive ? 'Syncing...' : 'Sync with Google Drive'} onClick={syncGoogleDrive}>
          <RefreshCw className={syncingDrive ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          <span className="hidden md:inline">{syncingDrive ? 'Syncing...' : 'Sync'}</span>
        </Button>
      </div>
    )
  }, [syncingDrive])


  // Drives are "connected" when the accounts list has entries OR pooled quota
  // exists in the storage summary — the empty dropzone must offer Upload (not
  // Connect) whenever storage is already available.
  const hasDrives = connectedAccounts.length > 0 || Number(storageSummary?.totalBytes ?? 0) > 0
  const activeFolder = allFolders.find((folder) => folder.id === activeFolderId)
  const folderBreadcrumbs = (() => {
    if (!activeFolder) return []
    const foldersById = new Map(allFolders.map((folder) => [folder.id, folder]))
    const path: FolderItem[] = []
    const visited = new Set<string>()
    let current: FolderItem | undefined = activeFolder
    while (current?.id && !visited.has(current.id)) {
      path.unshift(current)
      visited.add(current.id)
      current = current.parentId ? foldersById.get(current.parentId) : undefined
    }
    return path
  })()
  const allVisibleSelected = files.length > 0 && files.every((file) => file.id && selectedFileIds.has(file.id))

  // --- Client-side sorting + type filtering (no network re-fetch) ---
  const filteredFiles = useMemo(() => {
    if (typeFilter === 'all') return files
    return files.filter((file) => {
      if (typeFilter === 'video') return file.kind === 'video'
      if (typeFilter === 'image') return file.kind === 'image'
      if (typeFilter === 'audio') return (file.mimeType ?? '').startsWith('audio/')
      if (typeFilter === 'document') return file.kind === 'doc' || file.kind === 'pdf'
      return true
    })
  }, [files, typeFilter])

  const sortedFiles = useMemo(() => {
    const dir = sortDirection === 'asc' ? 1 : -1
    const sorted = [...filteredFiles].sort((a, b) => {
      let comparison = 0
      if (sortField === 'name') {
        comparison = a.name.localeCompare(b.name)
      } else if (sortField === 'updatedAt') {
        const aTime = a.createdAt ? new Date(a.createdAt).getTime() : new Date(a.date).getTime()
        const bTime = b.createdAt ? new Date(b.createdAt).getTime() : new Date(b.date).getTime()
        comparison = (Number.isNaN(aTime) ? 0 : aTime) - (Number.isNaN(bTime) ? 0 : bTime)
      } else if (sortField === 'sizeBytes') {
        const aSize = Number(a.sizeBytes ?? a.size?.replace(/[^\d.]/g, '') ?? 0)
        const bSize = Number(b.sizeBytes ?? b.size?.replace(/[^\d.]/g, '') ?? 0)
        comparison = (Number.isFinite(aSize) ? aSize : 0) - (Number.isFinite(bSize) ? bSize : 0)
      } else if (sortField === 'mimeType') {
        comparison = (a.mimeType ?? '').localeCompare(b.mimeType ?? '')
      }
      return comparison * dir
    })
    return sorted
  }, [filteredFiles, sortField, sortDirection])

  const sortedFolders = useMemo(() => {
    const dir = sortDirection === 'asc' ? 1 : -1
    const sorted = [...folders].sort((a, b) => {
      let comparison = 0
      if (sortField === 'name') {
        comparison = a.name.localeCompare(b.name)
      } else if (sortField === 'updatedAt') {
        comparison = a.name.localeCompare(b.name)
      } else {
        comparison = a.name.localeCompare(b.name)
      }
      return comparison * dir
    })
    return sorted
  }, [folders, sortField, sortDirection])

  const typeCounts = useMemo(() => ({
    all: files.length,
    video: files.filter((f) => f.kind === 'video').length,
    audio: files.filter((f) => (f.mimeType ?? '').startsWith('audio/')).length,
    document: files.filter((f) => f.kind === 'doc' || f.kind === 'pdf').length,
    image: files.filter((f) => f.kind === 'image').length,
  }), [files])

  const inspectorFile = inspectorFileId ? (files.find((file) => file.id === inspectorFileId) ?? null) : null

  // On wide (desktop) viewports, auto-select the first visible file ONCE when the
  // vault first loads so the Right Inspector renders immediately with metadata/
  // preview/actions — eliminating the empty black void. Seeding only once means a
  // later manual close (Escape / toggle / click-away) is respected and not undone.
  const autoSelectedRef = useRef(false)
  useEffect(() => {
    if (autoSelectedRef.current) return
    if (sortedFiles.length > 0 && typeof window !== 'undefined' && window.innerWidth >= 1024) {
      const first = sortedFiles[0]
      if (first?.id) {
        autoSelectedRef.current = true
        setInspectorFileId(first.id)
        setActiveFile(first)
      }
    }
  }, [sortedFiles])

  return (
    <>
      {/* Workstation layout: main browsing stage (scrolls) + optional inline Right Inspector. */}
      <div className="flex h-full min-h-0 w-full overflow-hidden">
      <div
        onContextMenu={openEmptyContextMenu}
        onClick={(event) => {
          // Click-away: deselect the file / collapse the Inspector when clicking
          // empty grid background (not a file card, not the sort dropdown).
          const target = event.target as HTMLElement
          if (target.closest('[data-file-card]')) return
          if (target.closest('[role="menu"]')) return
          if (target.closest('[data-sort-control]')) return
          if (sortMenuOpen) setSortMenuOpen(false)
          setInspectorFileId(null)
        }}
        className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-6 text-zinc-900 lg:px-8 dark:text-zinc-100">
      {message ? <p className="mt-3 rounded-xl border border-blue-200/60 bg-blue-50 p-3 text-sm text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-300">{message}</p> : null}
      {/* Global page header: identity on the left, display controls on the right. No filter chips here. */}
      <div className="mb-8 flex w-full flex-col gap-4 border-b border-white/[0.08] pb-5">
        {/* Page Identity (Left) + Viewport Controls (Right) */}
        <div className="flex items-center justify-between gap-4">
        {/* Left: Title (root) or breadcrumbs (subfolder) — never wraps. */}
        <nav className="flex min-w-0 shrink items-center gap-2 text-sm">
          {folderBreadcrumbs.length === 0 ? (
            <div className="flex shrink-0 items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-amber-500/20 bg-amber-500/10 text-amber-400">
                <Folder className="h-4 w-4" />
              </div>
              <div>
                <h1 className="text-lg font-semibold leading-tight tracking-tight text-zinc-900 dark:text-white">
                  All Files
                </h1>
                <p className="mt-0.5 font-mono text-[11px] text-zinc-400">
                  {sortedFiles.length} {sortedFiles.length === 1 ? 'file' : 'files'} • {folders.length} {folders.length === 1 ? 'folder' : 'folders'}
                </p>
              </div>
            </div>
          ) : (
            <>
              <button
                onClick={closeFolder}
                className="flex items-center gap-1.5 font-medium text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                <Folder className="h-4 w-4 text-zinc-400 dark:text-zinc-500" />
                <span>All Files</span>
              </button>

              {folderBreadcrumbs.map((folder, index) => (
                <span key={folder.id} className="flex min-w-0 items-center gap-2">
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-400 dark:text-zinc-600" />
                  {index === folderBreadcrumbs.length - 1 ? (
                    <span className="flex min-w-0 items-center gap-2 font-semibold text-zinc-900 dark:text-white">
                      <span className="truncate">{folder.name}</span>
                      <span className="shrink-0 rounded-full border border-zinc-200 bg-zinc-100 px-2 py-0.5 text-xs font-normal text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                        {files.length} {files.length === 1 ? 'item' : 'items'}
                      </span>
                    </span>
                  ) : (
                    <button className="truncate font-medium text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100" onClick={() => folder.id && openFolderById(folder.id)}>{folder.name}</button>
                  )}
                </span>
              ))}
            </>
          )}
        </nav>

        {/* Right: Display Settings Only (View Toggle + Sort + Inspector) */}
        <div className="flex shrink-0 items-center gap-2">

          {/* Bulk-selection actions (when active) */}
          {selectedFileIds.size > 0 ? <div className="flex items-center gap-2"><span className="text-sm font-extrabold text-slate-700 dark:text-zinc-300">{selectedFileIds.size} selected</span><div className="flex gap-1.5"><Button className="h-8" variant="outline" onClick={downloadBatchAsZip}><Download className="h-4 w-4" />ZIP</Button><Button className="h-8" variant="outline" onClick={() => setMoveOpen(true)}><FolderInput className="h-4 w-4" />Move</Button><Button className="h-8" variant="danger" onClick={() => setDeleteOpen(true)}><Trash2 className="h-4 w-4" />Delete</Button><Button className="h-8" variant="ghost" onClick={clearSelection}>Clear</Button></div></div> : null}

          {/* Grid / List Switcher */}
          <div className="flex items-center rounded-xl border border-white/10 bg-zinc-900/80 p-1">
            <button onClick={() => changeFileViewMode('grid')} className={cn('rounded-lg p-1.5 transition-all', fileViewMode === 'grid' ? 'bg-white/15 text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200')} aria-label="Grid view" aria-pressed={fileViewMode === 'grid'} title="Grid View"><LayoutGrid className="h-3.5 w-3.5" /></button>
            <button onClick={() => changeFileViewMode('list')} className={cn('rounded-lg p-1.5 transition-all', fileViewMode === 'list' ? 'bg-white/15 text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200')} aria-label="List view" aria-pressed={fileViewMode === 'list'} title="List View"><List className="h-3.5 w-3.5" /></button>
          </div>

          {/* Sort menu: single container — field button + divider + Asc/Desc toggle. */}
          <div data-sort-control="" className="relative flex items-center rounded-xl border border-white/10 bg-zinc-900/80 p-1">
            <button
              onClick={() => setSortMenuOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={sortMenuOpen}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium text-zinc-200 transition-colors hover:text-white"
            >
              <ArrowUpDown className="h-3 w-3 text-zinc-400" />
              <span>{sortFieldLabel[sortField]}</span>
            </button>
            <div className="mx-1 h-3.5 w-px bg-white/10" />
            <button
              onClick={() => setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')}
              className="rounded-lg p-1 text-zinc-400 transition-colors hover:text-white"
              aria-label={sortDirection === 'asc' ? 'Sorted ascending' : 'Sorted descending'}
              title={sortDirection === 'asc' ? 'Ascending' : 'Descending'}
            >
              {sortDirection === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
            </button>

            {sortMenuOpen ? (
              <div
                role="menu"
                className="absolute right-0 top-11 z-30 w-56 overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0e0f16]/95 p-1.5 shadow-2xl backdrop-blur-xl"
              >
                {([
                  { field: 'name' as SortField, label: 'Name', hint: sortDirection === 'asc' ? 'A to Z' : 'Z to A' },
                  { field: 'updatedAt' as SortField, label: 'Date Modified', hint: sortDirection === 'asc' ? 'Oldest' : 'Newest' },
                  { field: 'sizeBytes' as SortField, label: 'File Size', hint: sortDirection === 'asc' ? 'Smallest' : 'Largest' },
                  { field: 'mimeType' as SortField, label: 'File Type', hint: 'Categorical' },
                ]).map((option) => (
                  <button
                    key={option.field}
                    role="menuitemradio"
                    aria-checked={sortField === option.field}
                    onClick={() => { setSortField(option.field); setSortMenuOpen(false) }}
                    className={cn(
                      'flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-xs font-medium transition-colors',
                      sortField === option.field ? 'bg-blue-500/10 text-blue-300' : 'text-zinc-300 hover:bg-white/5 hover:text-white'
                    )}
                  >
                    <span>{option.label}</span>
                    <span className="font-mono text-[10px] uppercase text-zinc-500">{option.hint}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {/* Inspector toggle — show/hide the Right Inspector panel on demand. */}
          <button
            onClick={() => setInspectorFileId(inspectorFileId ? null : (sortedFiles[0]?.id || null))}
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-xl border transition-all',
              inspectorFileId
                ? 'border-blue-500/40 bg-blue-600/20 text-blue-400 shadow-sm'
                : 'border-white/10 bg-zinc-900/80 text-zinc-400 hover:text-white'
            )}
            title="Toggle File Details Inspector"
            aria-pressed={inspectorFileId != null}
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      </div>
      {cutFolder ? <p className="mt-3 rounded-xl border border-amber-200/60 bg-amber-50 p-3 text-sm font-semibold text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300"><ClipboardPaste className="mr-2 inline h-4 w-4" />Cut folder: {cutFolder.name}. Press Ctrl+V or right-click empty area to paste here.</p> : null}
      {/* Folders in the current scope (root or active folder) — inline shelf, no full-width void. */}
      {!loadError && folders.length > 0 ? (
        <section>
          <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            <span>Folders</span>
            <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] text-amber-500 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-500">
              {folders.length}
            </span>
          </div>
          <FolderGrid items={sortedFolders} onFolderMenu={openFolderMenu} onFolderOpen={openFolder} onDropItem={handleDropItem} />
        </section>
      ) : null}

      {loadError ? (
        <div className="mt-3 flex flex-col items-center gap-3 rounded-2xl border border-red-500/20 bg-red-500/5 px-6 py-14 text-center backdrop-blur-sm dark:border-red-500/15">
          <CloudOff className="h-10 w-10 text-red-500/80" />
          <div className="grid gap-1">
            <p className="text-base font-extrabold text-slate-900 dark:text-slate-100">Couldn't load your vault</p>
            <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">{loadError}</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => setReloadNonce((nonce) => nonce + 1)}>
            <RefreshCw className="h-3.5 w-3.5" />Retry
          </Button>
        </div>
      ) : files.length > 0 ? (
        <section className="mt-8 flex flex-col gap-4">
          {/* Unified Left-Aligned Files Toolbar: label + divider + filter pills, all anchored to the left. */}
          <div className="flex items-center gap-3 overflow-x-auto pb-1 no-scrollbar">
            {/* Section Label */}
            <div className="flex shrink-0 items-center gap-2">
              <span className="font-mono text-xs font-bold uppercase tracking-wider text-zinc-400">
                Files
              </span>
              <span className="rounded-full bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
                {sortedFiles.length}
              </span>
            </div>

            {/* Subtle Vertical Divider */}
            <div className="mx-1 h-4 w-px shrink-0 bg-white/10" />

            {/* Filter Pills Group (Anchored to the Left with Label) */}
            <div className="flex shrink-0 items-center gap-1.5">
              {([
                { id: 'all' as TypeFilter, label: 'All', count: typeCounts.all, icon: null },
                { id: 'video' as TypeFilter, label: 'Videos', count: typeCounts.video, icon: Film },
                { id: 'audio' as TypeFilter, label: 'Audio', count: typeCounts.audio, icon: Music },
                { id: 'document' as TypeFilter, label: 'Docs', count: typeCounts.document, icon: FileText },
                { id: 'image' as TypeFilter, label: 'Images', count: typeCounts.image, icon: ImageIcon },
              ]).map((item) => {
                const ChipIcon = item.icon
                const isActive = typeFilter === item.id
                return (
                  <button
                    key={item.id}
                    onClick={() => setTypeFilter(item.id)}
                    aria-pressed={isActive}
                    className={cn(
                      'flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-1 text-xs font-medium transition-all',
                      isActive
                        ? 'bg-blue-600 text-white shadow-sm shadow-blue-500/20'
                        : 'border border-white/[0.06] bg-zinc-900/80 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                    )}
                  >
                    {ChipIcon ? <ChipIcon className="h-3.5 w-3.5" /> : null}
                    <span>{item.label}</span>
                    <span className={cn(
                      'rounded-full px-1.5 py-0.5 font-mono text-[10px]',
                      isActive ? 'bg-blue-500 text-white' : 'bg-white/10 text-zinc-400'
                    )}>
                      {item.count}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="w-full">
            {sortedFiles.length === 0 ? (
              <div className="rounded-2xl border border-white/[0.06] bg-zinc-900/40 p-8 text-center font-mono text-xs text-zinc-500">
                No files found matching the selected filter.
              </div>
            ) : fileViewMode === 'grid' ? (
              <FileGrid files={sortedFiles} selectedFileIds={selectedFileIds} selectedFileId={inspectorFileId} onToggleFile={toggleFileSelection} onFileContextMenu={openContext} onFileOpen={openStage} onFileSelect={selectFileForInspector} resolveThumbUrl={resolvePreviewUrl} />
            ) : (
              <FileTable files={sortedFiles} selectedFileIds={selectedFileIds} allSelected={allVisibleSelected} onToggleFile={toggleFileSelection} onToggleAll={toggleAllVisibleFiles} onFileContextMenu={openContext} onFileOpen={openStage} />
            )}
          </div>
        </section>
      ) : searchQuery ? (
        <Card className="mt-3 border-slate-200/80 bg-white/70 p-5 dark:border-zinc-800/80 dark:bg-zinc-900/60">
          <p className="text-sm text-slate-500 dark:text-slate-400">No files found for "{searchQuery}".</p>
        </Card>
      ) : activeFolder && folders.length === 0 ? (
        /* Truly empty folder: clean Google-Drive-style empty state that still
           accepts drag & drop and click-to-upload. */
        <div
          onDragOver={(event) => { event.preventDefault(); setIsDraggingFiles(true) }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setIsDraggingFiles(false) }}
          onDrop={handleDropzoneDrop}
          onClick={() => setUploadOpen(true)}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setUploadOpen(true) } }}
          aria-label="Empty folder upload area"
          className={[
            'mt-3 flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-14 text-center transition-all',
            isDraggingFiles
              ? 'scale-[1.01] border-blue-500 bg-blue-50/80 shadow-lg shadow-blue-500/10 dark:border-blue-500/70 dark:bg-blue-950/40'
              : 'bg-white/60 border-slate-300 hover:border-blue-400 dark:bg-zinc-900/60 dark:border-zinc-800/80 dark:hover:border-blue-500/60',
          ].join(' ')}
        >
          <CloudUpload className="mb-3 h-8 w-8 text-slate-400 dark:text-zinc-500" />
          <p className="text-sm font-semibold text-slate-600 dark:text-zinc-300">This folder is empty</p>
          <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400">Drag and drop files here to get started.</p>
          <Button size="sm" className="mt-4" onClick={(event) => { event.stopPropagation(); setUploadOpen(true) }}>
            <Upload className="h-4 w-4" />Upload Files
          </Button>
        </div>
      ) : (
        <div
          onDragOver={(event) => { event.preventDefault(); setIsDraggingFiles(true) }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setIsDraggingFiles(false) }}
          onDrop={handleDropzoneDrop}
          onClick={() => setUploadOpen(true)}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setUploadOpen(true) } }}
          aria-label="Upload dropzone"
          className={[
            'mt-3 flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-16 text-center transition-all',
            isDraggingFiles
              ? 'scale-[1.01] border-blue-500 bg-blue-50/80 shadow-lg shadow-blue-500/10 dark:border-blue-500/70 dark:bg-blue-950/40'
              : 'bg-white/60 border-slate-300 hover:border-blue-400 dark:bg-zinc-900/60 dark:border-zinc-800/80 dark:hover:border-blue-500/60',
          ].join(' ')}
        >
          <div className={['mb-3 flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border transition-colors', isDraggingFiles ? 'border-blue-500 bg-blue-600 text-white' : 'border-blue-500/20 bg-blue-500/10 text-blue-400'].join(' ')}>
            <CloudUpload className="h-7 w-7" />
          </div>
          <div className="w-full">
            <p className="text-base font-medium text-slate-700 dark:text-zinc-200">Drag and drop files to pool &amp; upload</p>
            <p className="mx-auto text-sm text-slate-500 font-normal max-w-md text-center leading-relaxed mt-1 mb-6 dark:text-zinc-400">
              {hasDrives
                ? 'Drag and drop files here to pool and chunk across your connected storage.'
                : 'Files larger than single account quotas are automatically chunked across connected drives.'}
            </p>
          </div>
          {hasDrives ? (
            <Button
              size="sm"
              className="bg-blue-600 hover:bg-blue-500 shadow-lg shadow-blue-500/20"
              onClick={(event) => { event.stopPropagation(); setUploadOpen(true) }}
            >
              <Upload className="mr-2 h-4 w-4" />Upload Your First File
            </Button>
          ) : (
            <Button
              size="sm"
              className="shadow-lg shadow-blue-500/20 hover:shadow-blue-500/30"
              onClick={(event) => { event.stopPropagation(); navigate('/settings') }}
            >
              <Plus className="h-3.5 w-3.5" />Connect Storage Account
            </Button>
          )}
        </div>
      )}
      </div>

      {/* Persistent inline Right Inspector Panel — reserves width beside the browsing stage on wide screens. */}
      {inspectorFile ? (
        <aside className="hidden h-full w-80 shrink-0 flex-col overflow-y-auto border-l border-white/[0.08] bg-zinc-950/80 backdrop-blur-xl md:flex lg:w-[352px]">
          <FileInspector
            open={inspectorFileId != null}
            file={inspectorFile}
            resolveThumbUrl={resolvePreviewUrl}
            onClose={closeInspector}
            onDownload={inspectorDownload}
            onMove={inspectorMove}
            onRename={inspectorRename}
            onDelete={inspectorDelete}
          />
        </aside>
      ) : null}
      </div>
      <EmptyAreaContextMenu x={emptyContextMenu.x} y={emptyContextMenu.y} open={emptyContextMenu.open} canPasteFolder={Boolean(cutFolder)} onClose={() => setEmptyContextMenu({ x: 0, y: 0, open: false })} onUpload={() => { setUploadOpen(true); setEmptyContextMenu({ x: 0, y: 0, open: false }) }} onCreateFolder={() => { setFolderOpen(true); setEmptyContextMenu({ x: 0, y: 0, open: false }) }} onPasteFolder={() => { pasteFolder().catch((error) => setMessage(error instanceof Error ? error.message : 'Failed to paste folder')); setEmptyContextMenu({ x: 0, y: 0, open: false }) }} />
      <FileContextMenu x={contextMenu.x} y={contextMenu.y} file={contextMenu.file} onClose={() => setContextMenu({ x: 0, y: 0, file: null })} onView={viewFile} onDownload={downloadFile} onRename={() => { setRenameValue(activeFile?.name ?? ''); setRenameOpen(true); setContextMenu({ x: 0, y: 0, file: null }) }} onMove={() => { setMoveOpen(true); setContextMenu({ x: 0, y: 0, file: null }) }} onDetails={() => { setDetailOpen(true); setContextMenu({ x: 0, y: 0, file: null }) }} onShare={shareFile} onCopyLink={copyShareLinkDirect} onInvite={inviteToFile} onDelete={() => { setDeleteOpen(true); setContextMenu({ x: 0, y: 0, file: null }) }} />
      <FolderContextMenu x={folderContextMenu.x} y={folderContextMenu.y} folder={folderContextMenu.folder} onClose={() => setFolderContextMenu({ x: 0, y: 0, folder: null })} onCut={() => cutSelectedFolder(activeFolderForMenu)} onRename={() => { setFolderRenameValue(activeFolderForMenu?.name ?? ''); setFolderRenameColor(normalizeFolderColor(activeFolderForMenu?.color)); setFolderRenameIconUrl(activeFolderForMenu?.iconUrl ?? defaultFolderIconUrl); setFolderRenameOpen(true); setFolderContextMenu({ x: 0, y: 0, folder: null }) }} onInvite={inviteToFolder} onCopyLink={copyFolderLink} onDelete={() => { setFolderDeleteOpen(true); setFolderContextMenu({ x: 0, y: 0, folder: null }) }} />
      <FileDetailsDrawer open={detailOpen} file={activeFile} onClose={() => setDetailOpen(false)} />

      <DummyModal open={uploadOpen} title="Upload File" description="Stream file directly to selected Google Drive account." onClose={() => setUploadOpen(false)}>
        <form onSubmit={uploadFile} className="grid gap-4">
           <label onDragEnter={handleUploadDrag} onDragOver={handleUploadDrag} onDragLeave={handleUploadDrag} onDrop={handleUploadDrag} className={isUploadDragging ? 'grid cursor-pointer gap-3 rounded-2xl border-2 border-dashed border-blue-500 bg-blue-50 p-4 text-center transition sm:p-6 dark:border-blue-500/70 dark:bg-blue-950/40' : 'grid cursor-pointer gap-3 rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50 p-4 text-center transition hover:border-blue-300 hover:bg-blue-50/50 sm:p-6 dark:border-slate-700 dark:bg-slate-900/50 dark:hover:border-blue-500/60 dark:hover:bg-blue-950/30'}>
            <Upload className={isUploadDragging ? 'mx-auto h-8 w-8 text-blue-600' : 'mx-auto h-8 w-8 text-slate-500'} />
            <span className="text-sm font-extrabold text-slate-950">Drop file here or click to browse</span>
            <span className="text-xs text-slate-500">Metadata is sent before the file so upload can stream directly to Google Drive.</span>
            <Input type="file" className="sr-only" multiple onChange={(event) => selectUploadFiles(event.target.files)} required={selectedFiles.length === 0} />
          </label>
          <label className="grid gap-2 text-sm font-semibold">
            Target Storage Account
            <select
              className="h-11 rounded-xl border border-slate-200 px-3 text-sm bg-white dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              value={selectedTargetAccountId}
              onChange={(event) => setSelectedTargetAccountId(event.target.value)}
            >
              <option value="">Automatic (Default)</option>
              {connectedAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.email || account.displayName || account.id} ({account.provider === 's3' ? 'S3' : 'Google Drive'})
                </option>
              ))}
            </select>
          </label>
          {activeFolder ? <p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-600">Uploading to: <b>{activeFolder.name}</b></p> : <label className="grid gap-2 text-sm font-semibold">Virtual Folder<select className="h-11 rounded-xl border border-slate-200 px-3 text-sm bg-white" value={selectedFolderId} onChange={(event) => setSelectedFolderId(event.target.value)}><option value="">No folder</option>{allFolders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>}
          {selectedFiles.length > 0 ? <div className="grid max-h-56 gap-2 overflow-y-auto rounded-xl border border-slate-200/70 bg-slate-50 p-3 text-sm text-slate-600 dark:border-slate-700/60 dark:bg-slate-900/60 dark:text-slate-300"><div className="flex items-center justify-between gap-3"><span className="font-bold text-slate-950 dark:text-slate-100">{selectedFiles.length} selected</span><span className="shrink-0">{formatBytes(selectedFiles.reduce((total, file) => total + file.size, 0))}</span></div>{selectedFiles.map((file, index) => <div key={`${file.name}-${file.size}-${index}`} className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-slate-200/60 bg-white/80 px-3 py-2 dark:border-slate-700/60 dark:bg-slate-950/60"><span className="min-w-0 flex-1 truncate" title={file.name}>{file.name}</span><span className="shrink-0 text-xs text-slate-500">{formatBytes(file.size)}</span><button type="button" className="shrink-0 text-slate-500 hover:text-red-600 dark:hover:text-red-400" onClick={() => removeUploadFile(index)} aria-label={`Remove ${file.name}`}><X className="h-4 w-4" /></button></div>)}</div> : null}
          <div className="grid gap-3 sm:flex sm:justify-end"><Button type="button" variant="outline" onClick={() => setUploadOpen(false)}>Cancel</Button><Button disabled={loading || selectedFiles.length === 0}>{loading ? 'Uploading...' : `Upload${selectedFiles.length > 1 ? ` ${selectedFiles.length} files` : ''}`}</Button></div>
        </form>
      </DummyModal>
       <DummyModal open={folderOpen} title="New Folder" description="Create a virtual folder for organizing files." onClose={() => setFolderOpen(false)}>
        <form onSubmit={createFolder} className="grid gap-4">
          <label className="grid gap-2 text-sm font-semibold">Folder Name<Input value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder="Project Assets" required /></label>
          <FolderAppearanceFields color={folderColor} iconUrl={folderIconUrl} onColorChange={setFolderColor} onIconChange={setFolderIconUrl} />
          <div className="grid gap-3 pt-2 sm:flex sm:justify-end"><Button type="button" variant="outline" onClick={() => setFolderOpen(false)}>Cancel</Button><Button>Create Folder</Button></div>
        </form>
      </DummyModal>
      <DummyModal open={renameOpen} title="Rename File" description={activeFile?.name ?? ''} onClose={() => setRenameOpen(false)}><form onSubmit={renameFile} className="grid gap-4"><Input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} required /><div className="flex justify-end gap-3"><Button type="button" variant="outline" onClick={() => setRenameOpen(false)}>Cancel</Button><Button>Rename</Button></div></form></DummyModal>
      <DummyModal open={moveOpen} title="Move to Folder" description={selectedFileIds.size > 0 ? `Move ${selectedFileIds.size} files` : activeFile?.name ?? ''} onClose={() => setMoveOpen(false)}><form onSubmit={moveFile} className="grid gap-4"><select className="h-11 rounded-xl border border-slate-200 px-3 text-sm" value={selectedFolderId} onChange={(event) => setSelectedFolderId(event.target.value)}><option value="">No folder</option>{allFolders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select><div className="flex justify-end gap-3"><Button type="button" variant="outline" onClick={() => setMoveOpen(false)}>Cancel</Button><Button>Move</Button></div></form></DummyModal>
      <DummyModal open={deleteOpen} title={selectedFileIds.size > 0 ? 'Delete Files' : 'Delete File'} description={selectedFileIds.size > 0 ? `Delete ${selectedFileIds.size} files from Google Drive?` : `Delete ${activeFile?.name ?? 'file'} from Google Drive?`} onClose={() => setDeleteOpen(false)}><div className="flex justify-end gap-3"><Button variant="outline" onClick={() => setDeleteOpen(false)}>Cancel</Button><Button variant="danger" onClick={deleteFile}>Delete</Button></div></DummyModal>
      <DummyModal open={shareOpen} title="Share Link" description={activeFile?.name ?? ''} onClose={() => setShareOpen(false)}>
        <div className="grid gap-4">
          <div>
            <label className="text-xs font-bold text-slate-500 block mb-1">UniDrive Public Share Link (No GDrive login required)</label>
            <Input value={shareUrl} readOnly />
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => setShareOpen(false)}>Close</Button>
            <Button onClick={copyShareLink}>{copiedShareLink ? <CheckCircle className="h-4 w-4" /> : null}{copiedShareLink ? 'Copied!' : 'Copy Link'}</Button>
          </div>
          {copiedShareLink ? <p className="rounded-xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-700">Share link copied to clipboard.</p> : null}

          {activeFile?.accountProvider === 'google_drive' && (
            <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-800 grid gap-3">
              <div>
                <label className="text-xs font-bold text-slate-500 block mb-1">Google Drive Direct Link (Public Access)</label>
                <p className="text-xs text-slate-500 mb-2">Configure this file to be publicly accessible on Google Drive so external tools can edit/download it.</p>
              </div>
              {gdrivePublicUrl ? (
                <div className="grid gap-2">
                  <Input value={gdrivePublicUrl} readOnly />
                  <p className="rounded-xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-700">Google Drive public link generated and copied to clipboard!</p>
                </div>
              ) : (
                <Button
                  variant="outline"
                  disabled={makingPublic}
                  onClick={async () => {
                    if (!activeFile?.id) return
                    setMakingPublic(true)
                    try {
                      const res = await apiFetch<{ url: string }>('/files/' + activeFile.id + '/public-permission', { method: 'POST' })
                      setGdrivePublicUrl(res.url)
                      await navigator.clipboard.writeText(res.url)
                    } catch (err: any) {
                      alert('Failed to update Google Drive permission: ' + (err.message || err))
                    } finally {
                      setMakingPublic(false)
                    }
                  }}
                  className="w-full text-blue-700 bg-blue-50 border-blue-200 hover:bg-blue-100 dark:text-blue-400 dark:bg-blue-950/30 dark:border-blue-900/50"
                >
                  {makingPublic ? 'Making Public...' : 'Make Public & Copy GDrive Link'}
                </Button>
              )}
            </div>
          )}
        </div>
      </DummyModal>
      <DummyModal open={folderRenameOpen} title="Rename Folder" description={activeFolderForMenu?.name ?? ''} onClose={() => setFolderRenameOpen(false)}><form onSubmit={renameFolder} className="grid gap-4"><Input value={folderRenameValue} onChange={(event) => setFolderRenameValue(event.target.value)} required /><FolderAppearanceFields color={folderRenameColor} iconUrl={folderRenameIconUrl} onColorChange={setFolderRenameColor} onIconChange={setFolderRenameIconUrl} /><div className="flex justify-end gap-3"><Button type="button" variant="outline" onClick={() => setFolderRenameOpen(false)}>Cancel</Button><Button>Rename</Button></div></form></DummyModal>
      <DummyModal open={folderDeleteOpen} title="Delete Folder" description={`Delete virtual folder ${activeFolderForMenu?.name ?? ''}? Files inside will remain uploaded.`} onClose={() => setFolderDeleteOpen(false)}><div className="flex justify-end gap-3"><Button variant="outline" onClick={() => setFolderDeleteOpen(false)}>Cancel</Button><Button variant="danger" onClick={deleteFolder}>Delete</Button></div></DummyModal>
      <DummyModal open={inviteOpen} title="Invite Member" description={`Share ${inviteTargetType === 'file' ? (activeFile?.name ?? 'file') : (activeFolderForMenu?.name ?? 'folder')} with a team member.`} onClose={() => setInviteOpen(false)}>
        <form onSubmit={sendInvite} className="grid gap-4">
          <label className="grid gap-2 text-sm font-semibold">Email Address<Input type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="member@example.com" required /></label>
          <label className="grid gap-2 text-sm font-semibold">Role<select className="h-11 rounded-xl border border-slate-200 px-3 text-sm" value={inviteRole} onChange={(event) => setInviteRole(event.target.value)}><option value="viewer">Can view</option><option value="editor">Can edit</option></select></label>
          {inviteMessage ? <p className="rounded-xl bg-blue-50 p-3 text-sm font-semibold text-blue-700">{inviteMessage}</p> : null}
          <div className="flex justify-end gap-3 pt-2"><Button type="button" variant="outline" onClick={() => setInviteOpen(false)}>Cancel</Button><Button disabled={inviting}>{inviting ? 'Sending...' : 'Send Invite'}</Button></div>
        </form>
      </DummyModal>
      {previewOpen && (previewLoading || previewError) ? (
        <div className="fixed inset-0 z-50 flex animate-in flex-col items-center justify-center gap-4 bg-black/90 text-white backdrop-blur-2xl fade-in">
          {previewLoading ? (
            <>
              <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
              <p className="text-sm font-medium text-zinc-300">Loading preview...</p>
            </>
          ) : (
            <>
              <FileText className="h-10 w-10 text-rose-400" />
              <p className="text-sm font-medium text-rose-300">{previewError}</p>
              <button type="button" onClick={closePreview} className="rounded-xl border border-white/10 bg-white/10 px-4 py-2 text-xs font-medium text-white transition hover:bg-white/20">Close</button>
            </>
          )}
        </div>
      ) : null}
      {previewOpen && activeFile && !previewLoading && !previewError && previewUrl ? (
        <UniversalStage
          file={activeFile}
          queue={files}
          previewUrl={previewUrl}
          resolvePreviewUrl={resolvePreviewUrl}
          onPlayFile={(file) => { playFromStage(file).catch(() => undefined) }}
          onDownload={(file) => { downloadFile(file).catch(() => undefined) }}
          onMediaError={() => setPreviewError('Failed to load preview.')}
          onClose={closePreview}
        />
      ) : null}
    </>
  )
}
