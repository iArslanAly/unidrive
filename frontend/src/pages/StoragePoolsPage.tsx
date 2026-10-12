import { useCallback, useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Database, HardDrive, Plus, RefreshCw, ShieldCheck, Zap } from 'lucide-react'
import { apiFetch, formatBytes } from '@/lib/api'
import { cn } from '@/lib/utils'

type StorageSummary = { totalBytes: string; usedBytes: string; availableBytes: string }
type StorageBreakdown = { photo: string; video: string; document: string }
type ConnectedAccount = {
  id: string
  email: string
  displayName?: string | null
  provider: string
  status: string
  storageAccount?: { totalBytes: string | null; usedBytes: string; availableBytes: string | null; lastSyncedAt: string | null } | null
}
type RoutingMode = 'auto' | 'priority' | 'rules'
type RoutingTypeRules = { video?: string; document?: string; default?: string }
type RoutingPolicy = {
  id: string
  mode: RoutingMode
  priorityOrder: string[]
  safetyCapPercent: number
  typeRules: RoutingTypeRules
}

const MODE_OPTIONS: { id: RoutingMode; label: string }[] = [
  { id: 'auto', label: 'Smart Auto' },
  { id: 'priority', label: 'Priority' },
  { id: 'rules', label: 'By Type' },
]

function providerLabel(provider: string) {
  return provider === 's3' ? 'S3 Storage' : 'Google Drive'
}

function accountPercentUsed(account: ConnectedAccount) {
  const total = Number(account.storageAccount?.totalBytes ?? 0)
  const used = Number(account.storageAccount?.usedBytes ?? 0)
  if (total <= 0) return 0
  return Math.min(100, Math.round((used / total) * 100))
}

function accountFreeLabel(account: ConnectedAccount) {
  if (account.provider === 's3' && account.storageAccount?.availableBytes === null) return 'Unlimited'
  return formatBytes(account.storageAccount?.availableBytes)
}

function accountTotalLabel(account: ConnectedAccount) {
  if (account.provider === 's3' && account.storageAccount?.totalBytes === null) return 'Unlimited'
  return formatBytes(account.storageAccount?.totalBytes)
}

/** Official multi-color Google Drive mark for connected-account badges. */
function GoogleDriveLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 87.3 78" className={className} aria-hidden="true">
      <path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da" />
      <path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" fill="#00ac47" />
      <path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335" />
      <path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d" />
      <path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc" />
      <path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00" />
    </svg>
  )
}

/**
 * Storage Pools workstation: full-width pooled-capacity hero on top with a
 * balanced 2-column split below — connected accounts (left, span 7) and the
 * upload routing console (right, span 5) with Smart Auto / Priority Waterfall
 * / Rule-Based strategies plus the per-drive quota safety cap.
 */
export function StoragePoolsPage() {
  // 1. Storage stats & accounts state
  const [summary, setSummary] = useState<StorageSummary | null>(null)
  const [breakdown, setBreakdown] = useState<StorageBreakdown>({ photo: '0', video: '0', document: '0' })
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([])

  // 2. Routing mode state: 'auto' | 'priority' | 'rules'
  const [activeMode, setActiveMode] = useState<RoutingMode>('auto')

  // 3. Priority order & safety cap state
  const [priorityOrder, setPriorityOrder] = useState<string[]>([])
  const [safetyCapPercent, setSafetyCapPercent] = useState(85)
  const [typeRules, setTypeRules] = useState<RoutingTypeRules>({})

  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [syncingAccountId, setSyncingAccountId] = useState<string | null>(null)
  const [message, setMessage] = useState('')

  const fetchData = useCallback(async () => {
    const [summaryData, breakdownData, accountData, policyData] = await Promise.all([
      apiFetch<StorageSummary>('/storage/summary'),
      apiFetch<StorageBreakdown>('/storage/breakdown').catch(() => ({ photo: '0', video: '0', document: '0' }) as StorageBreakdown),
      apiFetch<{ accounts: ConnectedAccount[] }>('/connected-accounts'),
      apiFetch<{ policy: RoutingPolicy }>('/storage/routing-policy'),
    ])
    setSummary(summaryData)
    setBreakdown(breakdownData)
    setAccounts(accountData.accounts)
    setActiveMode(policyData.policy.mode)
    setPriorityOrder(policyData.policy.priorityOrder ?? [])
    setSafetyCapPercent(policyData.policy.safetyCapPercent ?? 85)
    setTypeRules(policyData.policy.typeRules ?? {})
  }, [])

  useEffect(() => {
    fetchData().catch((error) => setMessage(error instanceof Error ? error.message : 'Failed to load storage pools'))
  }, [fetchData])

  // OAuth popup handshake: the connect callback posts a message to the opener.
  // The popup.closed poll inside handleConnectDrive is the fallback handshake.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return
      if (event.data?.type !== 'UNIDRIVE_OAUTH_SUCCESS' && event.data?.type !== 'GOOGLE_CONNECTED') return
      setMessage(event.data.status === 'error' ? 'Google Drive connection failed.' : 'Google Drive connected.')
      fetchData()
        .then(() => window.dispatchEvent(new Event('9drive:storage-changed')))
        .catch(() => undefined)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [fetchData])

  async function refresh() {
    setIsRefreshing(true)
    try {
      await fetchData()
      setMessage('')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to refresh storage pools')
    } finally {
      setIsRefreshing(false)
    }
  }
  async function handleConnectDrive() {
    const popup = window.open('', 'google-drive-connect', 'width=540,height=720')
    if (popup) {
      popup.document.write('<html><head><title>Connecting...</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#090a10;color:#71717a;}</style></head><body><div style="text-align:center;"><h2>Connecting to Google...</h2><p>Please wait while we redirect you.</p></div></body></html>')
      const openedAt = Date.now()
      const poll = window.setInterval(() => {
        if (!popup.closed && Date.now() - openedAt < 10 * 60_000) return
        window.clearInterval(poll)
        if (!popup.closed) return
        fetchData()
          .then(() => window.dispatchEvent(new Event('9drive:storage-changed')))
          .catch(() => undefined)
      }, 800)
    }
    try {
      const data = await apiFetch<{ url: string }>('/connected-accounts/google/connect-url')
      if (popup) {
        popup.location.href = data.url
      } else {
        window.location.href = data.url
      }
    } catch (error) {
      if (popup) popup.close()
      setMessage(error instanceof Error ? error.message : 'Failed to start Google Drive connection')
    }
  }

  async function handleSyncAccount(accountId: string) {
    setSyncingAccountId(accountId)
    try {
      await apiFetch(`/connected-accounts/${accountId}/sync-quota`, { method: 'POST' })
      await fetchData()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to sync quota')
    } finally {
      setSyncingAccountId(null)
    }
  }

  function orderedAccounts() {
    const byId = new Map(accounts.map((account) => [account.id, account]))
    const ordered = priorityOrder.map((id) => byId.get(id)).filter((account): account is ConnectedAccount => Boolean(account))
    const orderedIds = new Set(ordered.map((account) => account.id))
    return [...ordered, ...accounts.filter((account) => !orderedIds.has(account.id))]
  }

  function movePriority(index: number, direction: -1 | 1) {
    const ids = orderedAccounts().map((account) => account.id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= ids.length) return
    const nextIds = [...ids]
    const [item] = nextIds.splice(index, 1)
    nextIds.splice(target, 0, item)
    setPriorityOrder(nextIds)
  }

  async function handleSaveRouting() {
    setIsSaving(true)
    try {
      const data = await apiFetch<{ policy: RoutingPolicy }>('/storage/routing-policy', {
        method: 'PUT',
        body: JSON.stringify({ mode: activeMode, priorityOrder, safetyCapPercent, typeRules }),
      })
      setActiveMode(data.policy.mode)
      setPriorityOrder(data.policy.priorityOrder ?? [])
      setSafetyCapPercent(data.policy.safetyCapPercent ?? 85)
      setTypeRules(data.policy.typeRules ?? {})
      setMessage('Routing policy saved.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to save routing policy')
    } finally {
      setIsSaving(false)
    }
  }

  // Derived pooled-capacity metrics
  const totalBytes = Number(summary?.totalBytes ?? 0)
  const usedBytes = Number(summary?.usedBytes ?? 0)
  const percentUsed = totalBytes > 0 ? Math.min(100, Math.round((usedBytes / totalBytes) * 100)) : 0
  const usedFormatted = formatBytes(summary?.usedBytes)
  const totalFormatted = formatBytes(summary?.totalBytes)
  const freeFormatted = formatBytes(summary?.availableBytes)
  const videoBytes = Number(breakdown.video ?? 0)
  const photoBytes = Number(breakdown.photo ?? 0)
  const documentBytes = Number(breakdown.document ?? 0)
  const segment = (bytes: number) => (totalBytes > 0 ? Math.min(100, Math.round(((bytes / totalBytes) * 100) * 10) / 10) : 0)
  const videoPercent = segment(videoBytes)
  const photosPercent = segment(photoBytes)
  const docsPercent = segment(documentBytes)
  const activeModeLabel = MODE_OPTIONS.find((option) => option.id === activeMode)?.label ?? 'Smart Auto'
  const displayAccounts = orderedAccounts()

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8">

      {/* 1. TOP HEADER */}
      <div className="flex flex-col gap-4 border-b border-white/[0.08] pb-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-blue-500/20 bg-blue-500/10 text-blue-400">
            <HardDrive className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white">Storage Pools</h1>
            <p className="mt-0.5 font-mono text-xs text-zinc-400">
              Multi-cloud aggregation, intelligent allocation &amp; quota guards
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={refresh}
            disabled={isRefreshing}
            className="flex cursor-pointer items-center gap-2 rounded-xl border border-white/10 bg-zinc-900/80 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-60"
          >
            <RefreshCw className={cn('h-3.5 w-3.5 text-zinc-400', isRefreshing && 'animate-spin')} />
            <span>Refresh</span>
          </button>
          <button
            onClick={handleConnectDrive}
            className="flex cursor-pointer items-center gap-2 rounded-xl bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-lg shadow-blue-500/20 transition-all hover:bg-blue-500"
          >
            <Plus className="h-4 w-4" />
            <span>Connect Drive</span>
          </button>
        </div>
      </div>

      {message ? (
        <p className="rounded-xl border border-blue-500/20 bg-blue-500/10 px-3.5 py-2.5 text-xs text-blue-300">{message}</p>
      ) : null}

      {/* 2. POOLED STORAGE HERO BANNER (Full-Width) */}
      <div className="w-full rounded-3xl border border-white/[0.08] bg-zinc-900/40 p-6 backdrop-blur-xl">
        <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-col gap-2">
            <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-zinc-500">
              Pooled Storage Capacity
            </span>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-3xl font-extrabold tracking-tight text-white">{usedFormatted}</span>
              <span className="font-mono text-sm text-zinc-400">of {totalFormatted}</span>
              <span className="ml-2 rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 font-mono text-xs font-semibold text-blue-400">
                {percentUsed}% used
              </span>
            </div>
          </div>

          {/* Quick Metrics */}
          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col gap-1 rounded-2xl border border-white/[0.06] bg-zinc-900/70 p-3">
              <span className="font-mono text-[10px] uppercase text-zinc-500">Active Pools</span>
              <span className="font-mono text-sm font-bold text-zinc-200">{accounts.length} Connected</span>
            </div>
            <div className="flex flex-col gap-1 rounded-2xl border border-white/[0.06] bg-zinc-900/70 p-3">
              <span className="font-mono text-[10px] uppercase text-zinc-500">Available Free</span>
              <span className="font-mono text-sm font-bold text-emerald-400">{freeFormatted}</span>
            </div>
            <div className="flex flex-col gap-1 rounded-2xl border border-white/[0.06] bg-zinc-900/70 p-3">
              <span className="font-mono text-[10px] uppercase text-zinc-500">Routing Mode</span>
              <span className="font-mono text-sm font-bold text-blue-400">{activeModeLabel}</span>
            </div>
          </div>
        </div>

        {/* Multi-Segmented Storage Bar */}
        <div className="mt-6 flex flex-col gap-2">
          <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full border border-white/[0.04] bg-zinc-800/80">
            <div style={{ width: `${videoPercent}%` }} className="h-full rounded-full bg-blue-500 transition-all duration-500" title="Videos" />
            <div style={{ width: `${docsPercent}%` }} className="h-full rounded-full bg-amber-400 transition-all duration-500" title="Documents" />
            <div style={{ width: `${photosPercent}%` }} className="h-full rounded-full bg-emerald-400 transition-all duration-500" title="Photos" />
          </div>
          <div className="flex flex-wrap items-center gap-4 pt-1 font-mono text-xs text-zinc-400">
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-blue-500" /> Videos: {formatBytes(videoBytes)}</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-400" /> Photos: {formatBytes(photoBytes)}</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-amber-400" /> Docs: {formatBytes(documentBytes)}</span>
            <span className="flex items-center gap-1.5 text-zinc-500"><span className="h-2 w-2 rounded-full bg-zinc-700" /> Free: {freeFormatted}</span>
          </div>
        </div>
      </div>
      {/* 3. 2-COLUMN BALANCED WORKSTATION GRID */}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">

        {/* LEFT COLUMN: Connected Accounts (Span 7) */}
        <div className="flex flex-col gap-4 lg:col-span-7">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs font-bold uppercase tracking-wider text-zinc-400">
                Connected Accounts
              </span>
              <span className="rounded-full bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
                {accounts.length}
              </span>
            </div>
            <span className="flex items-center gap-1.5 font-mono text-xs text-zinc-500">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> Auto-sync active
            </span>
          </div>

          {accounts.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/[0.1] bg-zinc-900/30 p-10 text-center">
              <HardDrive className="mx-auto h-10 w-10 text-blue-400/70" />
              <h3 className="mt-4 text-lg font-bold text-white">No connected drives</h3>
              <p className="mx-auto mt-2 max-w-sm text-sm text-zinc-400">
                Connect Google Drive or S3 storage to pool quota and start routing uploads intelligently.
              </p>
              <button
                onClick={handleConnectDrive}
                className="mt-5 inline-flex cursor-pointer items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-blue-500/20 transition-colors hover:bg-blue-500"
              >
                <Plus className="h-4 w-4" />Connect Drive
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-3.5">
              {displayAccounts.map((acc) => {
                const percent = accountPercentUsed(acc)
                return (
                  <div
                    key={acc.id}
                    className="group flex flex-col gap-3 rounded-2xl border border-white/[0.07] bg-zinc-900/50 p-5 shadow-lg transition-all duration-200 hover:border-blue-500/30 hover:bg-zinc-900/80"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.05] backdrop-blur-sm">
                          {acc.provider === 's3' ? (
                            <Database className="h-5 w-5 text-amber-400" />
                          ) : (
                            <GoogleDriveLogo className="h-5 w-5" />
                          )}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="text-sm font-semibold text-white">{providerLabel(acc.provider)}</h3>
                            <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] font-medium text-emerald-400">
                              Active
                            </span>
                          </div>
                          <p className="mt-0.5 font-mono text-xs text-zinc-400">{acc.email}</p>
                        </div>
                      </div>

                      <button
                        onClick={() => handleSyncAccount(acc.id)}
                        disabled={syncingAccountId === acc.id}
                        className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200 disabled:opacity-60"
                        aria-label={`Sync quota for ${acc.email}`}
                        title="Sync quota now"
                      >
                        <RefreshCw className={cn('h-3.5 w-3.5', syncingAccountId === acc.id && 'animate-spin')} />
                      </button>
                    </div>

                    {/* Quota Progress */}
                    <div className="mt-2 flex flex-col gap-1.5">
                      <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
                        <div
                          style={{ width: `${percent}%` }}
                          className="h-full rounded-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-all duration-500"
                        />
                      </div>
                      <div className="flex items-center justify-between font-mono text-xs text-zinc-400">
                        <span>{formatBytes(acc.storageAccount?.usedBytes)} / {accountTotalLabel(acc)} ({percent}%)</span>
                        <span>{accountFreeLabel(acc)} Available</span>
                      </div>
                    </div>

                    {/* Safety Cap Threshold Footnote */}
                    <div className="flex items-center justify-between border-t border-white/[0.04] pt-2 text-[11px] text-zinc-500">
                      <span className="flex items-center gap-1 font-mono">
                        <ShieldCheck className="h-3.5 w-3.5 text-blue-400" /> Safety Cap: {safetyCapPercent}% Active
                      </span>
                      <span className="font-mono text-zinc-400">Overflow: Enabled</span>
                    </div>
                  </div>
                )
              })}
              <button
                onClick={handleConnectDrive}
                className="group flex w-full cursor-pointer items-center justify-center gap-2.5 rounded-2xl border border-dashed border-white/15 bg-zinc-900/20 p-4 text-xs font-medium text-zinc-400 transition-all hover:border-blue-500/50 hover:bg-zinc-900/50 hover:text-zinc-200"
              >
                <Plus className="h-4 w-4 text-zinc-500 transition-colors group-hover:text-blue-400" />
                <span>Connect secondary drive to expand pooled capacity</span>
              </button>
            </div>
          )}
        </div>
        {/* RIGHT COLUMN: Upload Routing Engine (Span 5) */}
        <div className="flex flex-col gap-4 lg:col-span-5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs font-bold uppercase tracking-wider text-zinc-400">
              Upload Routing Engine
            </span>
            <span className="font-mono text-[11px] text-blue-400">Real-time</span>
          </div>

          <div className="flex flex-col gap-5 rounded-2xl border border-white/[0.08] bg-zinc-900/60 p-5 shadow-xl">
            <div>
              <h3 className="text-sm font-semibold text-white">Allocation Strategy</h3>
              <p className="mt-1 text-xs text-zinc-400">
                Choose how new uploads pick target storage accounts.
              </p>
            </div>

            {/* Mode Selector Tabs */}
            <div className="grid grid-cols-3 gap-1 rounded-xl border border-white/10 bg-zinc-950/80 p-1 text-xs">
              {MODE_OPTIONS.map((mode) => (
                <button
                  key={mode.id}
                  onClick={() => setActiveMode(mode.id)}
                  className={cn(
                    'cursor-pointer rounded-lg px-2 py-2 text-center font-medium transition-all',
                    activeMode === mode.id
                      ? 'bg-blue-600 text-white shadow-md'
                      : 'text-zinc-300 hover:bg-white/[0.06] hover:text-white'
                  )}
                >
                  <div className="text-xs">{mode.label}</div>
                </button>
              ))}
            </div>

            {/* Dynamic Context Box */}
            {activeMode === 'auto' ? (
              <div className="flex flex-col gap-2 rounded-xl border border-blue-500/20 bg-blue-500/[0.06] p-3.5 text-xs text-zinc-300">
                <div className="flex items-center gap-2 font-semibold text-blue-400">
                  <Zap className="h-4 w-4" /> Dynamic Capacity Balancing
                </div>
                <p className="text-[11px] leading-relaxed text-zinc-400">
                  Incoming files automatically target the drive with the highest available free space. If a drive reaches {safetyCapPercent}%, uploads route to secondary pools to prevent quota lockouts.
                </p>
              </div>
            ) : null}
            {activeMode === 'priority' ? (
              <div className="flex flex-col gap-2">
                <span className="font-mono text-xs text-zinc-400">Priority Order:</span>
                {displayAccounts.length === 0 ? (
                  <p className="text-xs text-zinc-500">Connect storage accounts to configure the waterfall.</p>
                ) : displayAccounts.map((acc, idx) => (
                  <div key={acc.id} className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-zinc-950/60 p-2.5 text-xs">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white/10 font-mono text-[10px] text-zinc-400">
                        {idx + 1}
                      </span>
                      <span className="truncate font-medium text-zinc-200">{acc.email}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => movePriority(idx, -1)}
                        disabled={idx === 0}
                        className="cursor-pointer p-1 text-zinc-400 transition-colors hover:text-white disabled:opacity-30"
                        aria-label={`Move ${acc.email} up`}
                      >
                        <ArrowUp className="h-3 w-3" />
                      </button>
                      <button
                        onClick={() => movePriority(idx, 1)}
                        disabled={idx === displayAccounts.length - 1}
                        className="cursor-pointer p-1 text-zinc-400 transition-colors hover:text-white disabled:opacity-30"
                        aria-label={`Move ${acc.email} down`}
                      >
                        <ArrowDown className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                ))}
                <p className="text-[11px] leading-relaxed text-zinc-500">
                  The first drive below the {safetyCapPercent}% cap with enough free space wins; capped drives are skipped.
                </p>
              </div>
            ) : null}

            {activeMode === 'rules' ? (
              <div className="flex flex-col gap-2.5 text-xs">
                <div className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-zinc-950/60 p-2.5">
                  <span className="text-zinc-300">Videos <span className="text-zinc-500">(video/*)</span></span>
                  <select
                    value={typeRules.video ?? ''}
                    onChange={(e) => setTypeRules({ ...typeRules, video: e.target.value || undefined })}
                    className="cursor-pointer rounded-lg border border-white/10 bg-zinc-900 px-2 py-1.5 font-mono text-[11px] text-blue-400 outline-none transition-colors hover:border-blue-500/40"
                  >
                    <option value="">Auto · highest capacity</option>
                    {accounts.map((acc) => (
                      <option key={acc.id} value={acc.id}>{acc.email}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-zinc-950/60 p-2.5">
                  <span className="text-zinc-300">Documents &amp; other files</span>
                  <select
                    value={typeRules.default ?? ''}
                    onChange={(e) => setTypeRules({ ...typeRules, default: e.target.value || undefined })}
                    className="cursor-pointer rounded-lg border border-white/10 bg-zinc-900 px-2 py-1.5 font-mono text-[11px] text-amber-400 outline-none transition-colors hover:border-amber-500/40"
                  >
                    <option value="">Primary drive</option>
                    {accounts.map((acc) => (
                      <option key={acc.id} value={acc.id}>{acc.email}</option>
                    ))}
                  </select>
                </div>
                <p className="text-[11px] leading-relaxed text-zinc-500">
                  Files route to the assigned pool first; if that pool is full or past the safety cap, Smart Auto takes over.
                </p>
              </div>
            ) : null}
            {/* Safety Cap Control (applies to every strategy) */}
            <div className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-zinc-950/60 p-2.5">
              <span className="flex items-center gap-1.5 text-xs text-zinc-300">
                <ShieldCheck className="h-3.5 w-3.5 text-blue-400" /> Quota safety cap
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setSafetyCapPercent((value) => Math.max(50, value - 5))}
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md border border-white/10 bg-zinc-900 font-mono text-xs text-zinc-400 transition-colors hover:text-white"
                  aria-label="Decrease safety cap"
                >
                  −
                </button>
                <span className="w-12 text-center font-mono text-xs font-semibold text-blue-400">{safetyCapPercent}%</span>
                <button
                  onClick={() => setSafetyCapPercent((value) => Math.min(95, value + 5))}
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md border border-white/10 bg-zinc-900 font-mono text-xs text-zinc-400 transition-colors hover:text-white"
                  aria-label="Increase safety cap"
                >
                  +
                </button>
              </div>
            </div>

            <button
              onClick={handleSaveRouting}
              disabled={isSaving}
              className="mt-1 w-full cursor-pointer rounded-xl border border-white/10 bg-white/10 py-2.5 text-xs font-semibold text-white transition-all hover:bg-white/15 disabled:opacity-60"
            >
              {isSaving ? 'Saving…' : 'Save Routing Policy'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}