import { createContext, useContext, useState, type ReactNode } from 'react'
import { API_URL, apiFetch } from '@/lib/api'
import { getAccessToken } from '@/lib/auth'

export type UploadProgressStatus = 'uploading' | 'done' | 'error' | 'partial'
export type UploadProgressFile = {
  name: string
  size: number
  percent: number
  status: UploadProgressStatus
  /** Chunk visualizer: 1-based index of the part currently streaming. */
  chunkIndex?: number
  /** Chunk visualizer: total parts for this file. */
  chunkTotal?: number
  /** Chunk visualizer: storage provider/email the current part is targeting. */
  provider?: string
  /** Human-readable failure reason shown in the error badge. */
  errorMessage?: string
}
export type UploadProgressState = {
  open: boolean
  fileName: string
  percent: number
  status: UploadProgressStatus
  files: UploadProgressFile[]
  /** Batch-level error banner (e.g. "No storage drive connected..."). */
  errorMessage?: string
}

type ResumableSession = { sessionId: string; file: File; folderId?: string | null; targetAccountId?: string | null; providerEmail?: string }

type UploadContextType = {
  uploadProgress: UploadProgressState
  setUploadProgress: React.Dispatch<React.SetStateAction<UploadProgressState>>
  uploadFiles: (files: File[], folderId: string | null, targetAccountId?: string | null) => Promise<void>
  retryFailedUpload: (fileName: string) => Promise<void>
}

const UploadContext = createContext<UploadContextType | undefined>(undefined)

/** Identifies a file uniquely so duplicate names/sizes can never stack entries. */
function fileKey(file: { name: string; size: number }) {
  return `${file.name}-${file.size}`
}

/** Matches backend "not enough / no connected account" failures. */
function isNoDriveError(message: string) {
  return /no connected storage account|not enough storage|combined connected storage|no storage drive/i.test(message)
}

async function hasNoConnectedAccounts(): Promise<boolean> {
  try {
    const data = await apiFetch<{ accounts: unknown[] }>('/connected-accounts')
    return data.accounts.length === 0
  } catch {
    return false
  }
}

export function UploadProvider({ children }: { children: ReactNode }) {
  const [uploadProgress, setUploadProgress] = useState<UploadProgressState>({
    open: false,
    fileName: '',
    percent: 0,
    status: 'uploading',
    files: []
  })
  const [resumableSessions, setResumableSessions] = useState<Record<string, ResumableSession>>({})

  async function uploadSingleFileResumable(file: File, folderId: string | null, onProgress: (percent: number, chunk?: { index: number; total: number }, provider?: string) => void, sessionIdToRetry?: string, targetAccountId?: string | null, providerEmailHint?: string) {
    const CHUNK_SIZE = 5 * 1024 * 1024 // 5MB chunks (must be multiple of 256KB for Google Drive)
    let sessionId = sessionIdToRetry || ''
    let startOffset = 0
    let providerEmail = providerEmailHint
    const chunkTotal = Math.max(1, Math.ceil(file.size / CHUNK_SIZE))

    // Pre-save session parameters so that retry is functional even if the init API call fails
    setResumableSessions(prev => ({
      ...prev,
      [file.name]: { sessionId, file, folderId, targetAccountId, providerEmail }
    }))

    // 1. Initialize or get status
    if (!sessionId) {
      const initData = await apiFetch<{ sessionId: string; provider: string; providerEmail?: string }>('/uploads/resumable/init', {
        method: 'POST',
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          sizeBytes: String(file.size),
          folderId: folderId || undefined,
          targetAccountId: targetAccountId || undefined
        })
      })
      sessionId = initData.sessionId
      providerEmail = initData.providerEmail ?? providerEmail
      // Update session with the active sessionId
      setResumableSessions(prev => ({
        ...prev,
        [file.name]: { sessionId, file, folderId, targetAccountId, providerEmail }
      }))
    } else {
      const statusData = await apiFetch<{ status: string; offset: string }>(`/uploads/resumable/status/${sessionId}`)
      startOffset = Number(statusData.offset)
      if (statusData.status === 'completed') {
        onProgress(100, { index: chunkTotal, total: chunkTotal }, providerEmail)
        return
      }
    }

    // 2. Upload chunk by chunk
    while (startOffset < file.size) {
      const endOffset = Math.min(startOffset + CHUNK_SIZE, file.size)
      const chunk = file.slice(startOffset, endOffset)
      const chunkIndex = Math.min(chunkTotal, Math.floor(startOffset / CHUNK_SIZE) + 1)

      // Surface the active part immediately so the drawer shows "Chunk N of M" while it streams
      onProgress(Math.min(99, Math.round((startOffset / file.size) * 100)), { index: chunkIndex, total: chunkTotal }, providerEmail)

      // We use raw fetch with authorization header for binary stream upload
      const response = await fetch(`${API_URL}/uploads/resumable/chunk/${sessionId}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${getAccessToken()}`,
          'Content-Range': `bytes ${startOffset}-${endOffset - 1}/${file.size}`,
          'Content-Length': String(chunk.size)
        },
        body: chunk
      })

      if (!response.ok) {
        throw new Error('Chunk upload failed')
      }

      const resData = await response.json() as { status: string; offset?: string }
      if (resData.status === 'completed') {
        onProgress(100, { index: chunkTotal, total: chunkTotal }, providerEmail)
        break
      }

      startOffset = Number(resData.offset)
      const percent = Math.min(99, Math.round((startOffset / file.size) * 100))
      onProgress(percent, { index: Math.min(chunkTotal, Math.floor(startOffset / CHUNK_SIZE) + 1), total: chunkTotal }, providerEmail)
    }
  }

  async function uploadFiles(filesToUpload: File[], targetFolderId: string | null, targetAccountId?: string | null) {
    if (filesToUpload.length === 0) return

    // Deduplicate (same file dropped twice or selected + dropped) so the drawer
    // never renders multiple entries for one file.
    const seenKeys = new Set<string>()
    const uniqueFiles = filesToUpload.filter((file) => {
      const key = fileKey(file)
      if (seenKeys.has(key)) return false
      seenKeys.add(key)
      return true
    })
    if (uniqueFiles.length === 0) return

    // Setup initial status
    setUploadProgress({
      open: true,
      fileName: uniqueFiles.length === 1 ? uniqueFiles[0].name : `${uniqueFiles.length} files`,
      percent: 0,
      status: 'uploading',
      files: uniqueFiles.map(f => ({ name: f.name, size: f.size, percent: 0, status: 'uploading' })),
      errorMessage: undefined
    })

    let noDriveCache: boolean | undefined

    // Upload files sequentially
    for (let i = 0; i < uniqueFiles.length; i++) {
      const file = uniqueFiles[i]
      try {
        await uploadSingleFileResumable(file, targetFolderId, (filePercent, chunk, provider) => {
          setUploadProgress((current) => {
            const nextFiles = [...current.files]
            // Identity lookup (name+size) instead of positional index to avoid mismatches.
            const idx = nextFiles.findIndex((entry) => entry.name === file.name && entry.size === file.size)
            if (idx >= 0) {
              nextFiles[idx] = {
                ...nextFiles[idx],
                percent: filePercent,
                status: filePercent >= 100 ? 'done' : 'uploading',
                chunkIndex: chunk?.index ?? nextFiles[idx].chunkIndex,
                chunkTotal: chunk?.total ?? nextFiles[idx].chunkTotal,
                provider: provider ?? nextFiles[idx].provider,
              }
            }
            const overallPercent = Math.round(nextFiles.reduce((sum, f) => sum + f.percent, 0) / nextFiles.length)
            return {
              ...current,
              percent: overallPercent,
              files: nextFiles
            }
          })
        }, undefined, targetAccountId)
      } catch (err) {
        console.error('File upload failed:', file.name, err)
        const rawMessage = err instanceof Error ? err.message : 'Upload failed'
        let friendlyMessage: string | undefined
        if (isNoDriveError(rawMessage)) {
          noDriveCache ??= await hasNoConnectedAccounts()
          friendlyMessage = noDriveCache
            ? 'No storage drive connected. Please link Google Drive in Settings first.'
            : rawMessage
        }
        setUploadProgress((current) => {
          const nextFiles = [...current.files]
          const idx = nextFiles.findIndex((entry) => entry.name === file.name && entry.size === file.size)
          if (idx >= 0) {
            nextFiles[idx] = { ...nextFiles[idx], status: 'error', errorMessage: friendlyMessage ?? rawMessage }
          }
          return {
            ...current,
            status: 'partial',
            errorMessage: friendlyMessage ?? current.errorMessage,
            files: nextFiles
          }
        })
      }
    }

    // Dispatch global events so active pages reload their data
    window.dispatchEvent(new Event('9drive:storage-changed'))
    window.dispatchEvent(new Event('9drive:upload-completed'))
  }

  async function retryFailedUpload(fileName: string) {
    const session = resumableSessions[fileName]
    if (!session) return

    setUploadProgress((current) => {
      const nextFiles = current.files.map(f => f.name === fileName ? { ...f, status: 'uploading' as const, errorMessage: undefined } : f)
      return {
        ...current,
        status: 'uploading',
        errorMessage: undefined,
        files: nextFiles
      }
    })

    try {
      await uploadSingleFileResumable(session.file, session.folderId || null, (filePercent, chunk, provider) => {
        setUploadProgress((current) => {
          const nextFiles = [...current.files]
          const idx = nextFiles.findIndex((entry) => entry.name === fileName && entry.size === session.file.size)
          if (idx >= 0) {
            nextFiles[idx] = {
              ...nextFiles[idx],
              percent: filePercent,
              status: filePercent >= 100 ? 'done' : 'uploading',
              chunkIndex: chunk?.index ?? nextFiles[idx].chunkIndex,
              chunkTotal: chunk?.total ?? nextFiles[idx].chunkTotal,
              provider: provider ?? nextFiles[idx].provider,
            }
          }
          const overallPercent = Math.round(nextFiles.reduce((sum, f) => sum + f.percent, 0) / nextFiles.length)
          const allDone = nextFiles.every(f => f.status === 'done')
          return {
            ...current,
            percent: overallPercent,
            status: allDone ? 'done' : 'uploading',
            files: nextFiles
          }
        })
      }, session.sessionId, session.targetAccountId, session.providerEmail)

      window.dispatchEvent(new Event('9drive:storage-changed'))
      window.dispatchEvent(new Event('9drive:upload-completed'))
    } catch (err) {
      console.error('Retry upload failed:', fileName, err)
      const message = err instanceof Error ? err.message : 'Upload failed'
      setUploadProgress((current) => {
        const nextFiles = current.files.map(f => f.name === fileName ? { ...f, status: 'error' as const, errorMessage: message } : f)
        return {
          ...current,
          status: 'partial',
          errorMessage: isNoDriveError(message) ? message : current.errorMessage,
          files: nextFiles
        }
      })
    }
  }

  return (
    <UploadContext.Provider value={{ uploadProgress, setUploadProgress, uploadFiles, retryFailedUpload }}>
      {children}
    </UploadContext.Provider>
  )
}

export function useUpload() {
  const context = useContext(UploadContext)
  if (context === undefined) {
    throw new Error('useUpload must be used within an UploadProvider')
  }
  return context
}
