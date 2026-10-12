import { ArrowDownToLine, CheckCircle2, Gauge, Layers } from 'lucide-react'
import { formatBytes } from '@/lib/api'
import { cn } from '@/lib/utils'

type StorageSummary = { totalBytes: string; usedBytes: string; availableBytes: string }
type StorageBreakdown = { photo: string; video: string; document: string }

/**
 * Hero storage overview: a rich glass card replacing four detached stat boxes.
 * Shows a pooled usage headline, a multi-color segmented quota bar (video /
 * photos / documents / free space), and quick allocation badges.
 */
export function StorageOverviewCard({
  summary,
  breakdown,
  accountsCount,
  routingModeLabel,
}: {
  summary: StorageSummary | null
  breakdown: StorageBreakdown
  accountsCount: number
  routingModeLabel: string
}) {
  const total = Number(summary?.totalBytes ?? 0)
  const available = Number(summary?.availableBytes ?? 0)
  const video = Number(breakdown.video ?? 0)
  const photo = Number(breakdown.photo ?? 0)
  const document = Number(breakdown.document ?? 0)
  const used = total > 0 ? total - available : video + photo + document
  const usedPct = total > 0 ? Math.min(100, (used / total) * 100) : 0

  // Segment widths are percentages of TOTAL capacity so the bar reads as a
  // true partition of the pool (tiny slivers at low usage are expected/correct).
  const seg = (bytes: number) => (total > 0 ? (bytes / total) * 100 : 0)

  const segments = [
    { key: 'video', label: 'Video', bytes: video, color: 'bg-blue-500', dot: 'bg-blue-500' },
    { key: 'photo', label: 'Photos', bytes: photo, color: 'bg-emerald-400', dot: 'bg-emerald-400' },
    { key: 'document', label: 'Documents', bytes: document, color: 'bg-amber-400', dot: 'bg-amber-400' },
  ]

  return (
    <div className="relative mb-8 overflow-hidden rounded-3xl border border-white/[0.08] bg-zinc-900/40 p-6 backdrop-blur-xl">
      {/* Ambient glow */}
      <div className="pointer-events-none absolute -right-16 -top-24 h-56 w-56 rounded-full bg-blue-500/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -left-10 h-48 w-48 rounded-full bg-indigo-500/10 blur-3xl" />

      <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
        {/* Headline */}
        <div className="min-w-0">
          <p className="font-mono text-xs uppercase tracking-wider text-zinc-500">Pooled Storage</p>
          <h2 className="mt-2 text-3xl font-bold tracking-tight text-white">
            {formatBytes(summary?.usedBytes)} <span className="text-base font-medium text-zinc-500">of {formatBytes(summary?.totalBytes)}</span>
          </h2>
          <p className="mt-1 font-mono text-xs text-zinc-400">{usedPct.toFixed(1)}% used</p>

          {/* Segmented quota bar */}
          <div className="mt-5 w-full max-w-xl">
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-zinc-800">
              {segments.map((s) => (
                s.bytes > 0 ? (
                  <div key={s.key} className={cn('h-full', s.color)} style={{ width: `${seg(s.bytes)}%` }} title={`${s.label}: ${formatBytes(s.bytes)}`} />
                ) : null
              ))}
              <div className="h-full flex-1 bg-zinc-800" title={`Free: ${formatBytes(summary?.availableBytes)}`} />
            </div>
            {/* Legend */}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
              {segments.map((s) => (
                <span key={s.key} className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-400">
                  <span className={cn('h-2 w-2 rounded-full', s.dot)} />
                  {s.label} <span className="text-zinc-500">({formatBytes(s.bytes)})</span>
                </span>
              ))}
              <span className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-400">
                <span className="h-2 w-2 rounded-full bg-zinc-700" />
                Free <span className="text-zinc-500">({formatBytes(summary?.availableBytes)})</span>
              </span>
            </div>
          </div>
        </div>

        {/* Quick stat badges */}
        <div className="grid shrink-0 grid-cols-1 gap-2.5 sm:grid-cols-3 lg:grid-cols-1">
          <StatBadge icon={Layers} label="Active Pools" value={`${accountsCount} Connected`} />
          <StatBadge icon={ArrowDownToLine} label="Free Capacity" value={formatBytes(summary?.availableBytes)} />
          <StatBadge icon={Gauge} label="Allocation Strategy" value={routingModeLabel} />
        </div>
      </div>
    </div>
  )
}

function StatBadge({ icon: Icon, label, value }: { icon: typeof Layers; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.03] px-3.5 py-2.5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{label}</p>
        <p className="truncate text-sm font-semibold text-zinc-100">{value}</p>
      </div>
    </div>
  )
}

/** Small helper reused by cards to show a live "synced" tick when available. */
export function SyncTick({ synced }: { synced: boolean }) {
  if (!synced) return null
  return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
}
