import { useState } from 'react'
import { Cloud, Database, MoreVertical, RefreshCw, Trash2, Link2 } from 'lucide-react'
import { GoogleLogo } from '@/components/auth/GoogleLogo'
import { formatBytes } from '@/lib/api'
import { cn } from '@/lib/utils'

type ConnectedAccount = {
  id: string
  email: string
  displayName?: string | null
  provider: string
  status: string
  storageAccount?: { totalBytes: string | null; usedBytes: string; availableBytes: string | null; lastSyncedAt: string | null } | null
}

function providerName(provider: string) {
  return provider === 's3' ? 'S3 Storage' : 'Google Drive'
}

/** Brand-tinted provider badge: the real Google "G" mark or an S3 database glyph. */
function ProviderBadge({ provider }: { provider: string }) {
  if (provider === 's3') {
    return (
      <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-amber-400">
        <Database className="h-5 w-5" />
      </div>
    )
  }
  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04]">
      <GoogleLogo className="h-5 w-5" />
    </div>
  )
}

function quotaPct(account: ConnectedAccount) {
  const total = Number(account.storageAccount?.totalBytes ?? 0)
  const used = Number(account.storageAccount?.usedBytes ?? 0)
  if (total <= 0) return 0
  return Math.min(100, Math.round((used / total) * 100))
}

function limitLabel(account: ConnectedAccount) {
  if (account.provider === 's3' && account.storageAccount?.totalBytes === null) return 'Unlimited'
  return formatBytes(account.storageAccount?.totalBytes)
}

function availableLabel(account: ConnectedAccount) {
  if (account.provider === 's3' && account.storageAccount?.availableBytes === null) return 'Unlimited'
  return formatBytes(account.storageAccount?.availableBytes)
}

/**
 * Connected cloud provider cards: brand badge, live status pill, gradient quota
 * gauge, and a quick action menu (Sync now / Re-authenticate / Disconnect).
 */
export function ConnectedAccountsList({
  accounts,
  syncingAccountId,
  onSync,
  onReauthenticate,
  onDisconnect,
  onConnect,
}: {
  accounts: ConnectedAccount[]
  syncingAccountId: string | null
  onSync: (id: string) => void
  onReauthenticate: (id: string) => void
  onDisconnect: (id: string) => void
  onConnect: () => void
}) {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)

  if (accounts.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-white/[0.1] bg-zinc-900/30 p-10 text-center">
        <Cloud className="mx-auto h-10 w-10 text-blue-400/70" />
        <h3 className="mt-4 text-lg font-bold text-white">No connected drives</h3>
        <p className="mx-auto mt-2 max-w-sm text-sm text-zinc-400">Connect Google Drive or S3-compatible storage to start aggregating quota and auto-routing uploads.</p>
        <button onClick={onConnect} className="mt-5 inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-blue-500/20 transition-colors hover:bg-blue-500">
          <Link2 className="h-4 w-4" />Connect Account
        </button>
      </div>
    )
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {accounts.map((account) => {
        const percent = quotaPct(account)
        return (
          <div key={account.id} className="group rounded-2xl border border-white/[0.07] bg-zinc-900/50 p-5 shadow-lg transition-all duration-200 hover:border-blue-500/30 hover:bg-zinc-900/80">
            {/* Header */}
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <ProviderBadge provider={account.provider} />
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-white">{providerName(account.provider)}</h3>
                  <p className="truncate font-mono text-xs text-zinc-400">{account.email}</p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 font-mono text-[11px] text-emerald-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  Active
                </span>
                {/* 3-dot action menu */}
                <div className="relative">
                  <button
                    onClick={() => setOpenMenuId(openMenuId === account.id ? null : account.id)}
                    className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/5 hover:text-white"
                    aria-label={`Manage ${account.email}`}
                  >
                    <MoreVertical className="h-4 w-4" />
                  </button>
                  {openMenuId === account.id ? (
                    <div className="absolute right-0 top-9 z-30 w-44 overflow-hidden rounded-xl border border-white/[0.08] bg-[#0e0f16]/95 p-1 shadow-2xl backdrop-blur-xl">
                      <MenuAction icon={RefreshCw} label="Sync now" onClick={() => { setOpenMenuId(null); onSync(account.id) }} />
                      <MenuAction icon={Link2} label="Re-authenticate" onClick={() => { setOpenMenuId(null); onReauthenticate(account.id) }} />
                      <div className="my-1 h-px bg-white/[0.06]" />
                      <MenuAction icon={Trash2} label="Disconnect" danger onClick={() => { setOpenMenuId(null); onDisconnect(account.id) }} />
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            {/* Quota gauge */}
            <div className="mt-4">
              <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-all duration-500"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <div className="mt-2.5 flex items-center justify-between font-mono text-xs">
                <span className="text-zinc-300">{formatBytes(account.storageAccount?.usedBytes)} / {limitLabel(account)} <span className="text-zinc-500">({percent}%)</span></span>
                <span className="text-zinc-400">{availableLabel(account)} Available</span>
              </div>
              {account.storageAccount?.lastSyncedAt ? (
                <p className="mt-2 flex items-center gap-1.5 text-[10px] text-zinc-500">
                  <RefreshCw className={cn('h-3 w-3', syncingAccountId === account.id && 'animate-spin')} />
                  Synced {new Date(account.storageAccount.lastSyncedAt).toLocaleString()}
                </p>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function MenuAction({ icon: Icon, label, onClick, danger }: { icon: typeof RefreshCw; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-medium transition-colors',
        danger ? 'text-red-400 hover:bg-red-500/10' : 'text-zinc-300 hover:bg-white/5 hover:text-white'
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  )
}

