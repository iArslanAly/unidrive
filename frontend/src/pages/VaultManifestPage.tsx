import { useCallback, useEffect, useState } from 'react'
import { DatabaseBackup, FileJson, RefreshCw, ShieldCheck, ShieldAlert, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { PageHeader } from '@/components/drive/PageHeader'
import { apiFetch, API_URL, formatDate } from '@/lib/api'
import { getAccessToken } from '@/lib/auth'

type ManifestChunk = { chunkIndex: number; size: string; providerEmail: string; remoteFileId: string }
type ManifestFile = { id: string; name: string; virtualPath: string; totalSize: string; mimeType: string; isChunked: boolean; status: string; chunks: ManifestChunk[] }
type VaultManifest = { version: number; name: string; appFolder: string; updatedAt: string; files: ManifestFile[]; accounts: { email: string }[] }

type SyncReport = {
  totalFiles: number
  totalChunks: number
  verifiedChunks: number
  missingChunks: { virtualFileId: string; chunkIndex: number; providerEmail: string }[]
  lostFiles: string[]
  unverifiedChunks: number
  syncedAt: string
}

type RestoreReport = { restoredFiles: number; restoredChunks: number; adoptedAccounts: number; skippedAccounts: number }

/**
 * Vault Manifest — backup & sync status for the local-first vault.
 * Exports the sealed `.vault_manifest.json`, verifies every chunk against its
 * provider, and restores the index from a manifest file.
 */
export function VaultManifestPage() {
  const [manifest, setManifest] = useState<VaultManifest | null>(null)
  const [syncReport, setSyncReport] = useState<SyncReport | null>(null)
  const [restoreReport, setRestoreReport] = useState<RestoreReport | null>(null)
  const [busy, setBusy] = useState<'load' | 'sync' | 'export' | 'restore' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    setBusy('load')
    setError('')
    try {
      const data = await apiFetch<{ manifest: VaultManifest }>('/vault/manifest')
      setManifest(data.manifest)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the vault manifest.')
    } finally {
      setBusy(null)
    }
  }, [])

  useEffect(() => {
    load().catch(() => undefined)
  }, [load])

  async function syncAndVerify() {
    setBusy('sync')
    setError('')
    setNotice('')
    try {
      const data = await apiFetch<{ report: SyncReport; manifest: VaultManifest }>('/vault/manifest/sync', { method: 'POST' })
      setSyncReport(data.report)
      setManifest(data.manifest)
      setNotice(`Verified ${data.report.verifiedChunks}/${data.report.totalChunks} chunks across ${data.report.totalFiles} vault files.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Vault sync failed.')
    } finally {
      setBusy(null)
    }
  }

  async function exportManifest() {
    setBusy('export')
    setError('')
    try {
      const response = await fetch(`${API_URL}/vault/manifest`, { headers: { Authorization: `Bearer ${getAccessToken()}` } })
      if (!response.ok) throw new Error('Failed to build the vault manifest.')
      const data = await response.json() as { manifest?: unknown }
      const blob = new Blob([JSON.stringify(data.manifest ?? data, null, 2)], { type: 'application/json' })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = '.vault_manifest.json'
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(url)
      setNotice('Manifest exported as .vault_manifest.json — keep it safe for disaster recovery.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed.')
    } finally {
      setBusy(null)
    }
  }

  async function restoreManifest(file: File) {
    setBusy('restore')
    setError('')
    setNotice('')
    try {
      const parsed = JSON.parse(await file.text()) as unknown
      const data = await apiFetch<{ report: RestoreReport }>('/vault/manifest/restore', {
        method: 'POST',
        body: JSON.stringify({ manifest: parsed }),
      })
      setRestoreReport(data.report)
      setNotice(`Restored ${data.report.restoredFiles} files and ${data.report.restoredChunks} chunks from the manifest.`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Restore failed — is this a valid .vault_manifest.json file?')
    } finally {
      setBusy(null)
    }
  }

  const chunkedCount = manifest?.files.filter((file) => file.isChunked).length ?? 0


  return (
    <div className="min-h-[620px] w-full min-w-0">
      <PageHeader
        title="Vault Manifest"
        description="Backup, verify, and restore your vault index across connected drives."
        actions={
          <Button size="sm" onClick={syncAndVerify} disabled={busy !== null}>
            <RefreshCw className={busy === 'sync' ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />{busy === 'sync' ? 'Verifying...' : 'Sync & Verify'}
          </Button>
        }
      />

      {error ? (
        <div className="mt-4 flex items-start gap-2 rounded-2xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm font-semibold text-red-600 dark:text-red-400">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" className="shrink-0 text-red-500/70 hover:text-red-600" aria-label="Dismiss" onClick={() => setError('')}>✕</button>
        </div>
      ) : null}
      {notice ? (
        <div className="mt-4 flex items-start gap-2 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-sm font-semibold text-emerald-600 dark:text-emerald-400">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">{notice}</span>
          <button type="button" className="shrink-0 text-emerald-500/70 hover:text-emerald-600" aria-label="Dismiss" onClick={() => setNotice('')}>✕</button>
        </div>
      ) : null}

      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: 'Vault Files', value: manifest ? String(manifest.files.length) : '—', icon: FileJson },
          { label: 'Chunked Files', value: manifest ? String(chunkedCount) : '—', icon: DatabaseBackup },
          { label: 'Linked Accounts', value: manifest ? String(manifest.accounts.length) : '—', icon: ShieldCheck },
          { label: 'Verified Chunks', value: syncReport ? `${syncReport.verifiedChunks}/${syncReport.totalChunks}` : 'Not synced yet', icon: RefreshCw },
        ].map((tile) => (
          <Card key={tile.label} className="p-4">
            <div className="flex items-center gap-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              <tile.icon className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />{tile.label}
            </div>
            <p className="mt-2 text-2xl font-extrabold text-slate-900 dark:text-zinc-100">{tile.value}</p>
          </Card>
        ))}
      </div>


      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            <h2 className="text-[16px] font-bold">Vault Security &amp; Recovery</h2>
          </div>
          <p className="mt-1.5 text-[13px] text-slate-500 dark:text-slate-400">
            The manifest is an encrypted index of every virtual file, chunk location, and sealed account token.
            Sync it to all connected drives, then restore it from any single account if this database is lost.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={exportManifest} disabled={busy !== null || !manifest}>
              <Upload className="h-4 w-4" />{busy === 'export' ? 'Exporting...' : 'Export Manifest'}
            </Button>
            <label className="inline-flex">
              <input
                type="file"
                accept="application/json,.json"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) restoreManifest(file).catch(() => undefined)
                  event.target.value = ''
                }}
              />
              <span className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-950 shadow-sm transition hover:bg-slate-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800">
                <DatabaseBackup className="h-4 w-4" />Restore from File
              </span>
            </label>
          </div>
          {restoreReport ? (
            <p className="mt-3 rounded-xl bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-600 dark:bg-zinc-900 dark:text-zinc-300">
              Last restore: {restoreReport.restoredFiles} files · {restoreReport.restoredChunks} chunks · {restoreReport.adoptedAccounts} accounts adopted
            </p>
          ) : null}
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-2.5">
            <RefreshCw className="h-5 w-5 text-blue-600 dark:text-blue-400" />
            <h2 className="text-[16px] font-bold">Sync Status</h2>
          </div>
          {syncReport ? (
            <div className="mt-3 grid gap-2 text-[13px]">
              <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">Last verified</span><span className="font-bold text-slate-800 dark:text-zinc-200">{formatDate(syncReport.syncedAt)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">Verified chunks</span><span className="font-bold text-emerald-600 dark:text-emerald-400">{syncReport.verifiedChunks}</span></div>
              <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">Unverified (account offline)</span><span className="font-bold text-slate-600 dark:text-zinc-300">{syncReport.unverifiedChunks}</span></div>
              <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">Missing chunks</span><span className={syncReport.missingChunks.length > 0 ? 'font-bold text-red-600 dark:text-red-400' : 'font-bold text-slate-600 dark:text-zinc-300'}>{syncReport.missingChunks.length}</span></div>
              <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">Lost files</span><span className={syncReport.lostFiles.length > 0 ? 'font-bold text-red-600 dark:text-red-400' : 'font-bold text-slate-600 dark:text-zinc-300'}>{syncReport.lostFiles.length}</span></div>
            </div>
          ) : (
            <p className="mt-2 text-[13px] text-slate-500 dark:text-slate-400">No sync run yet. Click "Sync &amp; Verify" to check every chunk against its connected drive.</p>
          )}
          {manifest ? (
            <p className="mt-3 text-[11px] font-semibold text-slate-400 dark:text-slate-500">
              Manifest v{manifest.version} · folder <span className="font-mono">{manifest.appFolder}</span> · {manifest.accounts.length} sealed account(s)
            </p>
          ) : null}
        </Card>
      </div>
    </div>
  )
}

