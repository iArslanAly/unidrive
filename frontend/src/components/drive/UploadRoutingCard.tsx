import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react'
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
type RoutingMode = 'most_available' | 'round_robin' | 'priority'
type RoutingPolicy = { mode: RoutingMode; priorityAccountIds: string[]; roundRobinCursor: number }

const MODES: { id: RoutingMode; label: string }[] = [
  { id: 'most_available', label: 'Most Available' },
  { id: 'round_robin', label: 'Round Robin' },
  { id: 'priority', label: 'Priority Order' },
]

function providerName(provider: string) {
  return provider === 's3' ? 'S3' : 'Google Drive'
}

function freeLabel(account: ConnectedAccount) {
  if (account.provider === 's3' && account.storageAccount?.availableBytes === null) return 'Unlimited'
  return `${formatBytes(account.storageAccount?.availableBytes)} free`
}

/**
 * Smart upload routing module: allocation-mode pills plus a reorderable priority
 * list of connected drives (used when mode = Priority Order; the list also
 * seeds Round Robin order).
 */
export function UploadRoutingCard({
  routingPolicy,
  orderedAccounts,
  onChangeMode,
  onMove,
}: {
  routingPolicy: RoutingPolicy
  orderedAccounts: ConnectedAccount[]
  onChangeMode: (mode: RoutingMode) => void
  onMove: (accountId: string, direction: -1 | 1) => void
}) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-zinc-900/50 p-5 shadow-lg">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-base font-bold text-white">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400">
              <GripVertical className="h-4 w-4" />
            </span>
            Smart Upload Routing
          </h3>
          <p className="mt-1 text-xs text-zinc-400">Choose how new uploads pick a connected storage account.</p>
        </div>

        {/* Allocation mode pills */}
        <div className="flex flex-wrap items-center gap-1.5">
          {MODES.map((mode) => {
            const active = routingPolicy.mode === mode.id
            return (
              <button
                key={mode.id}
                onClick={() => onChangeMode(mode.id)}
                aria-pressed={active}
                className={cn(
                  'rounded-xl px-3 py-1.5 text-xs font-semibold transition-all',
                  active
                    ? 'bg-blue-600 text-white shadow-md shadow-blue-500/20'
                    : 'border border-white/[0.07] bg-zinc-900/60 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                )}
              >
                {mode.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Priority / order rows */}
      <div className="mt-5 grid gap-2.5">
        {orderedAccounts.length === 0 ? (
          <p className="text-xs text-zinc-500">Connect storage accounts to configure routing.</p>
        ) : orderedAccounts.map((account, index) => (
          <div key={account.id} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.05] bg-white/[0.02] p-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white/5 font-mono text-[11px] text-zinc-400">{index + 1}</span>
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-zinc-100">{account.displayName || account.email}</p>
                <p className="truncate font-mono text-[11px] text-zinc-500">{providerName(account.provider)} · {freeLabel(account)}</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                onClick={() => onMove(account.id, -1)}
                disabled={index === 0}
                className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/[0.07] bg-zinc-900/60 text-zinc-400 transition-colors hover:text-white disabled:opacity-30"
                aria-label={`Move ${account.email} up`}
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => onMove(account.id, 1)}
                disabled={index === orderedAccounts.length - 1}
                className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/[0.07] bg-zinc-900/60 text-zinc-400 transition-colors hover:text-white disabled:opacity-30"
                aria-label={`Move ${account.email} down`}
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
