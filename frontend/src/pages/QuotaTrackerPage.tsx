import { useEffect, useState } from 'react'
import { CheckCircle, Link2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/drive/PageHeader'
import { StorageOverviewCard } from '@/components/drive/StorageOverviewCard'
import { ConnectedAccountsList } from '@/components/drive/ConnectedAccountsList'
import { UploadRoutingCard } from '@/components/drive/UploadRoutingCard'
import { apiFetch } from '@/lib/api'

type StorageSummary = { totalBytes: string; usedBytes: string; availableBytes: string }
type StorageBreakdown = { photo: string; video: string; document: string }
type ConnectedAccount = { id: string; email: string; displayName?: string | null; provider: string; status: string; storageAccount?: { totalBytes: string | null; usedBytes: string; availableBytes: string | null; lastSyncedAt: string | null } | null }
type RoutingMode = 'most_available' | 'round_robin' | 'priority'
type RoutingPolicy = { mode: RoutingMode; priorityAccountIds: string[]; roundRobinCursor: number }

const routingModeLabels: Record<RoutingMode, string> = {
  most_available: 'Most Available',
  round_robin: 'Round Robin',
  priority: 'Priority Order',
}

export function QuotaTrackerPage() {
  const [summary, setSummary] = useState<StorageSummary | null>(null)
  const [breakdown, setBreakdown] = useState<StorageBreakdown>({ photo: '0', video: '0', document: '0' })
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([])
  const [routingPolicy, setRoutingPolicy] = useState<RoutingPolicy>({ mode: 'most_available', priorityAccountIds: [], roundRobinCursor: 0 })
  const [message, setMessage] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [syncingAccountId, setSyncingAccountId] = useState<string | null>(null)

  async function load() {
    const [summaryData, breakdownData, accountData, policyData] = await Promise.all([
      apiFetch<StorageSummary>('/storage/summary'),
      apiFetch<StorageBreakdown>('/storage/breakdown').catch(() => ({ photo: '0', video: '0', document: '0' }) as StorageBreakdown),
      apiFetch<{ accounts: ConnectedAccount[] }>('/connected-accounts'),
      apiFetch<{ policy: RoutingPolicy }>('/storage/routing-policy'),
    ])
    setSummary(summaryData)
    setBreakdown(breakdownData)
    setAccounts(accountData.accounts)
    setRoutingPolicy(policyData.policy)
  }

  async function refresh() {
    setRefreshing(true)
    try {
      await load()
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    load().catch((error) => setMessage(error instanceof Error ? error.message : 'Failed to load quota tracker'))
  }, [])

  useEffect(() => {
    if (!autoRefresh) return
    const timer = window.setInterval(() => load().catch(() => undefined), 35_000)
    return () => window.clearInterval(timer)
  }, [autoRefresh])

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.data?.type !== 'GOOGLE_CONNECTED') return
      setMessage(event.data.status === 'success' ? 'Google Drive connected.' : 'Google Drive connection failed.')
      load().catch(() => undefined)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  async function connectDrive() {
    const popup = window.open('', 'google-drive-connect', 'width=540,height=720')
    if (popup) {
      popup.document.write('<html><head><title>Connecting...</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc;color:#64748b;}</style></head><body><div style="text-align:center;"><h2>Connecting to Google...</h2><p>Please wait while we redirect you.</p></div></body></html>')
      // Fallback handshake: poll popup.closed every 800ms so a missed postMessage
      // still triggers a refetch of accounts + sidebar storage stats.
      const openedAt = Date.now()
      const poll = window.setInterval(() => {
        if (!popup.closed && Date.now() - openedAt < 10 * 60_000) return
        window.clearInterval(poll)
        if (!popup.closed) return
        load().then(() => {
          window.dispatchEvent(new Event('9drive:storage-changed'))
        }).catch(() => undefined)
      }, 800)
    }
    try {
      const data = await apiFetch<{ url: string }>('/connected-accounts/google/connect-url')
      if (popup) {
        popup.location.href = data.url
      } else {
        window.location.href = data.url
      }
    } catch (e) {
      if (popup) popup.close()
      console.error('Failed to start Google Drive connection from Quota Tracker', e)
    }
  }

  async function sync(accountId: string) {
    setSyncingAccountId(accountId)
    try {
      await apiFetch(`/connected-accounts/${accountId}/sync-quota`, { method: 'POST' })
      await load()
    } finally {
      setSyncingAccountId(null)
    }
  }

  async function disconnect(accountId: string) {
    if (!window.confirm('Disconnect this storage account? Files remain in your vault, but uploads will no longer route here.')) return
    try {
      await apiFetch(`/connected-accounts/${accountId}`, { method: 'DELETE' })
      setMessage('Account disconnected.')
      await load()
      window.dispatchEvent(new Event('9drive:storage-changed'))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to disconnect account')
    }
  }

  async function saveRoutingPolicy(nextPolicy: RoutingPolicy) {
    setRoutingPolicy(nextPolicy)
    const data = await apiFetch<{ policy: RoutingPolicy }>('/storage/routing-policy', { method: 'PATCH', body: JSON.stringify({ mode: nextPolicy.mode, priorityAccountIds: nextPolicy.priorityAccountIds }) })
    setRoutingPolicy(data.policy)
    setMessage('Upload routing policy updated.')
  }

  function orderedAccounts() {
    const byId = new Map(accounts.map((account) => [account.id, account]))
    const ordered = routingPolicy.priorityAccountIds.map((id) => byId.get(id)).filter((account): account is ConnectedAccount => Boolean(account))
    const orderedIds = new Set(ordered.map((account) => account.id))
    return [...ordered, ...accounts.filter((account) => !orderedIds.has(account.id))]
  }

  function moveAccount(accountId: string, direction: -1 | 1) {
    const ids = orderedAccounts().map((account) => account.id)
    const index = ids.indexOf(accountId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= ids.length) return
    const nextIds = [...ids]
    const [item] = nextIds.splice(index, 1)
    nextIds.splice(target, 0, item)
    saveRoutingPolicy({ ...routingPolicy, priorityAccountIds: nextIds }).catch((error) => setMessage(error instanceof Error ? error.message : 'Failed to update routing policy'))
  }

  return (
    <>
      <PageHeader title="Quota Tracker" description="Track and manage connected provider storage limits." actions={<><Button variant="outline" onClick={() => setAutoRefresh(!autoRefresh)}><CheckCircle className="h-4 w-4" />Auto-refresh {autoRefresh ? 'On' : 'Off'}</Button><Button variant="outline" onClick={refresh} disabled={refreshing}><RefreshCw className={refreshing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />{refreshing ? 'Refreshing...' : 'Refresh'}</Button><Button onClick={connectDrive}><Link2 className="h-4 w-4" />Connect Drive</Button></>} />
      {message ? <p className="mt-5 rounded-xl bg-blue-50 p-3 text-sm text-blue-700">{message}</p> : null}

      <StorageOverviewCard
        summary={summary}
        breakdown={breakdown}
        accountsCount={accounts.length}
        routingModeLabel={routingModeLabels[routingPolicy.mode]}
      />

      <UploadRoutingCard
        routingPolicy={routingPolicy}
        orderedAccounts={orderedAccounts()}
        onChangeMode={(mode) => saveRoutingPolicy({ ...routingPolicy, mode }).catch((error) => setMessage(error instanceof Error ? error.message : 'Failed to update routing policy'))}
        onMove={moveAccount}
      />

      <div className="mt-6">
        <ConnectedAccountsList
          accounts={accounts}
          syncingAccountId={syncingAccountId}
          onSync={sync}
          onReauthenticate={() => setMessage('Re-authentication is not yet supported for this account type.')}
          onDisconnect={disconnect}
          onConnect={connectDrive}
        />
      </div>
    </>
  )
}
