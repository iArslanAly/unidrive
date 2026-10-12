import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { Outlet, NavLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import type { DriveLayoutContext } from '@/context/DriveLayoutContext'
import {
  Bell,
  CloudCog,
  Heart,
  LogOut,
  Menu,
  Moon,
  MoreVertical,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Sun,
  Trash2,
  X,
  ShieldCheck,
  HardDrive,
  Info,
  CheckCircle,
  ChevronDown,
  RotateCw,
  Upload,
  Vault,
  Loader2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { BrandLogo } from '@/components/drive/BrandLogo'
import { DummyModal } from '@/components/drive/DummyModal'
import { Input } from '@/components/ui/input'
import { apiFetch, formatBytes } from '@/lib/api'
import { useUpload } from '@/context/UploadContext'
import { clearAuthSession, getStoredUser, updateStoredUser, type AuthUser } from '@/lib/auth'
import { getGravatarUrl } from '@/lib/gravatar'
import { cn } from '@/lib/utils'

/** True on Apple platforms — used to label the search shortcut as ⌘K vs Ctrl K. */
const isMacPlatform = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)

/** UniDrive nav — focused on the local-first vault workflow. */
const menu = [
  { label: 'Vault', icon: Vault, href: '/all-files' },
  { label: 'Storage Pools', icon: CloudCog, href: '/quota' },
  { label: 'Vault Manifest', icon: ShieldCheck, href: '/vault-manifest' },
  { label: 'Recycle Bin', icon: Trash2, href: '/trash' },
  { label: 'Settings', icon: Settings, href: '/settings' },
]

/** Routes grouped under the Vault section — powers the header "Vault / …" breadcrumb. */
const vaultSectionPaths = new Set(['/all-files', '/recent', '/starred', '/archived', '/shared', '/activity'])

type StorageSummary = {
  totalBytes: string
  usedBytes: string
  availableBytes: string
}

type StorageBreakdown = {
  photo: string
  video: string
  document: string
}

function SystemInfoDropdown({ storage }: { storage: any }) {
  const activeGoogle = storage?.accounts?.filter((a: any) => a.provider === 'google_drive' && a.status === 'connected') ?? []

  return (
    <div className="absolute right-0 top-12 z-50 w-[min(calc(100vw-2rem),22rem)] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl shadow-slate-950/15 dark:border-zinc-800/80 dark:bg-zinc-900/95 dark:shadow-black/40">
      <div className="border-b border-slate-200 px-4 py-3 bg-slate-50/50">
        <p className="text-sm font-extrabold text-slate-950">Workspace Status & Info</p>
        <p className="text-xs text-slate-500">Overview of your connections & guidelines</p>
      </div>
      <div className="max-h-96 overflow-y-auto p-4 space-y-4">
        {/* Connection status */}
        <div>
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5 text-emerald-500" /> Connection Status</h4>
          <div className="mt-2 space-y-2">
            <div className="flex items-center justify-between text-xs rounded-xl bg-slate-50 p-2.5 border border-slate-100">
              <span className="font-semibold text-slate-700">Google Drive accounts</span>
              <span className={activeGoogle.length > 0 ? "text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full font-bold border border-emerald-100" : "text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full font-bold border border-amber-100"}>
                {activeGoogle.length} Connected
              </span>
            </div>
            {activeGoogle.map((acc: any) => (
              <p key={acc.id} className="text-[11px] text-slate-500 truncate px-2.5">— {acc.email}</p>
            ))}
          </div>
        </div>

        {/* Database & engine status */}
        <div>
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5"><HardDrive className="h-3.5 w-3.5 text-blue-500" /> Storage Engine</h4>
          <div className="mt-2 text-xs text-slate-600 space-y-1 bg-slate-50 p-2.5 rounded-xl border border-slate-100">
            <p>• <b>DB Type:</b> SQLite (Local Database)</p>
            <p>• <b>Upload Folder:</b> Google Drive dedicated <code>UniDrive</code></p>
            <p>• <b>Max Upload Size:</b> 5 GB per stream</p>
          </div>
        </div>

        {/* Tips & Guides */}
        <div>
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5"><Info className="h-3.5 w-3.5 text-indigo-500" /> Usage Tips</h4>
          <ul className="mt-2 text-[11px] text-slate-500 list-disc list-inside space-y-1 pl-1">
            <li>Virtual folders exist only in your SQLite database.</li>
            <li>Physical files are always uploaded straight to Google Drive.</li>
            <li>Use the Sync button to fetch changes made directly on Drive.</li>
          </ul>
        </div>
      </div>
    </div>
  )
}

function Sidebar({ onNavigate, user, storage, breakdown, onLogout, accountsCount }: { onNavigate?: () => void; user: AuthUser | null; storage: StorageSummary | null; breakdown: StorageBreakdown; onLogout: () => void; accountsCount: number }) {
  const navigate = useNavigate()
  const used = Number(storage?.usedBytes ?? 0)
  const total = Number(storage?.totalBytes ?? 0)
  const progress = total > 0 ? Math.min(100, (used / total) * 100) : 0
  // A drive counts as connected when the accounts list has entries OR the
  // storage summary already reports pooled quota — the two can briefly desync
  // (OAuth handoff, refetch failure), so quota is treated as proof of a drive.
  const hasDrives = accountsCount > 0 || total > 0
  const driveCount = Math.max(accountsCount, 1)
  const drivesLabel = `${driveCount} Drive${driveCount === 1 ? '' : 's'} Connected`
  const [profileImageUrl, setProfileImageUrl] = useState('')
  const [avatarError, setAvatarError] = useState(false)
  const [supportOpen, setSupportOpen] = useState(false)
  const items = [
    ['Photo', formatBytes(breakdown.photo), 'bg-lime-500'],
    ['Video', formatBytes(breakdown.video), 'bg-yellow-400'],
    ['Document', formatBytes(breakdown.document), 'bg-cyan-400'],
    ['Free Storage', formatBytes(storage?.availableBytes), 'bg-orange-500'],
  ]

  useEffect(() => {
    setAvatarError(false)
    getGravatarUrl(user?.email, 64).then(setProfileImageUrl).catch(() => setProfileImageUrl(''))
  }, [user?.email])

  return (
    <>
    <aside className="flex h-full w-64 flex-col border-slate-200/60 bg-slate-50/40 backdrop-blur-xl p-4 lg:border-r">
      <div className="flex items-center gap-2.5 pb-3 pt-1">
        <BrandLogo className="h-8 w-8" />
        <span className="text-xl font-extrabold tracking-tight bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent">UniDrive</span>
      </div>

      <div className="flex items-center gap-2.5 border-y border-slate-200/60 py-3 my-3">
        {!profileImageUrl || avatarError ? (
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 text-xs font-bold text-white shadow-sm border border-blue-400/20">
            {(user?.name ?? user?.email ?? 'U').trim().charAt(0).toUpperCase()}
          </div>
        ) : (
          <img
            src={profileImageUrl}
            alt="User avatar"
            className="h-8 w-8 rounded-full border border-slate-200 object-cover"
            onError={() => setAvatarError(true)}
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-bold text-slate-900 leading-none">{user?.name ?? 'User'}</p>
          <p className="truncate text-xs text-slate-500 mt-1">{user?.email ?? 'Loading...'}</p>
        </div>
        <MoreVertical className="h-4 w-4 text-slate-400" />
      </div>

      <nav className="grid gap-1">
        {menu.map((item) => (
          <NavLink key={item.label} to={item.href} onClick={onNavigate} className={({ isActive }) => cn('inline-flex h-10 items-center gap-2.5 rounded-xl px-3.5 text-[13px] font-bold transition-all border border-transparent', isActive ? 'bg-blue-600/10 text-blue-600 border-blue-600/10 shadow-sm dark:bg-blue-500/15 dark:text-blue-400 dark:border-blue-500/20' : 'text-slate-600 hover:bg-slate-200/50 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-100')}>
            <item.icon className="h-4 w-4" />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto border-t border-slate-200/60 pt-4 text-[13px]">
        <div className="mb-3 space-y-1.5">
          {items.map(([label, value, color]) => (
            <div key={label} className="flex items-center justify-between text-slate-500 font-medium">
              <span className="flex items-center gap-1.5"><span className={cn('h-1.5 w-1.5 rounded-full', color)} />{label}</span>
              <span className="font-semibold text-slate-700">{value}</span>
            </div>
          ))}
        </div>
        <div className="flex justify-between text-sm font-bold text-slate-700 dark:text-slate-200">
          <span>{formatBytes(storage?.usedBytes)} used</span>
          <span className="text-slate-400 dark:text-slate-500">{formatBytes(storage?.totalBytes)}</span>
        </div>
        <div className="my-2 h-1.5 rounded-full bg-slate-200/60 overflow-hidden">
          <div className="h-full rounded-full bg-blue-600 transition-all duration-300" style={{ width: `${progress}%` }} />
        </div>
        {hasDrives ? (
          <button
            type="button"
            onClick={() => { navigate('/quota'); onNavigate?.() }}
            title="Manage connected drives in Storage Pools"
            className="mx-auto mt-3 flex w-full max-w-full min-w-0 items-center justify-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full border border-blue-300/70 bg-blue-50/70 px-3 py-1.5 text-[11px] font-bold text-blue-700 transition hover:border-blue-400 hover:bg-blue-50 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300 dark:hover:border-blue-500/50 dark:hover:bg-blue-500/15"
          >
            <HardDrive className="h-3.5 w-3.5 shrink-0" />{drivesLabel}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => { navigate('/settings'); onNavigate?.() }}
            title="Link a Google Drive account in Settings"
            className="mx-auto mt-3 flex w-full max-w-full min-w-0 items-center justify-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full border border-blue-300/70 bg-blue-50/70 px-3 py-1.5 text-[11px] font-bold text-blue-700 transition hover:border-blue-400 hover:bg-blue-50 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300 dark:hover:border-blue-500/50 dark:hover:bg-blue-500/15"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" />No Drives Connected
          </button>
        )}
        <button
          type="button"
          onClick={() => setSupportOpen(true)}
          className="mt-3 inline-flex w-full items-center gap-2 rounded-xl px-3 py-2 text-[12px] font-bold text-slate-500 transition hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10 dark:hover:text-rose-400"
        >
          <Heart className="h-3.5 w-3.5" />Support UniDrive
        </button>
        <Button variant="danger" size="sm" className="mt-1 w-full justify-start h-10 px-3 text-[13px] font-bold" onClick={onLogout}>
          <LogOut className="h-4 w-4" />Log Out
        </Button>
      </div>
    </aside>
    {/* Rendered outside <aside>: its backdrop-filter would otherwise trap the
        fixed-position dialog inside the 264px sidebar. */}
      <DummyModal open={supportOpen} title="Support UniDrive" description="Thank you for using UniDrive!" onClose={() => setSupportOpen(false)}>
        <div className="grid gap-3 text-sm text-slate-600">
          <p>UniDrive is a free, local-first storage pooler. If it saves your storage bill, consider supporting the project:</p>
          <ul className="list-disc space-y-1.5 pl-5 text-[13px]">
            <li>Star the project on GitHub and share it with friends.</li>
            <li>Report bugs and suggest features on the issue tracker.</li>
            <li>Contribute code, translations, or documentation.</li>
          </ul>
          <div className="flex justify-end pt-1">
            <Button size="sm" onClick={() => setSupportOpen(false)}>Close</Button>
          </div>
        </div>
      </DummyModal>
    </>
  )
}

type ConnectedAccount = {
  id: string
  email: string
  provider: string
}

export function DriveLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false)
  const [searchValue, setSearchValue] = useState(searchParams.get('q') ?? '')
  const [user, setUser] = useState<AuthUser | null>(getStoredUser())
  const [storage, setStorage] = useState<StorageSummary | null>(null)
  const [breakdown, setBreakdown] = useState<StorageBreakdown>({ photo: '0', video: '0', document: '0' })
  const [infoOpen, setInfoOpen] = useState(false)
  const [headerActions, setHeaderActions] = useState<ReactNode>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const { uploadProgress, setUploadProgress, retryFailedUpload } = useUpload()
  const [uploadProgressCollapsed, setUploadProgressCollapsed] = useState(false)
  /** Per-row "Details" toggles so long error messages can be read in full without widening the drawer. */
  const [expandedUploadErrors, setExpandedUploadErrors] = useState<Record<string, boolean>>({})
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('9drive:theme')
    if (saved === 'light' || saved === 'dark') return saved
    return 'dark'
  })

  // Advanced search states
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([])
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [filterKind, setFilterKind] = useState(searchParams.get('kind') ?? '')
  const [filterAccountId, setFilterAccountId] = useState(searchParams.get('accountId') ?? '')
  const [filterMinSize, setFilterMinSize] = useState(() => {
    const min = searchParams.get('minSize')
    return min ? String(Math.round(Number(min) / (1024 * 1024))) : ''
  })
  const [filterMaxSize, setFilterMaxSize] = useState(() => {
    const max = searchParams.get('maxSize')
    return max ? String(Math.round(Number(max) / (1024 * 1024))) : ''
  })
  const [filterStartDate, setFilterStartDate] = useState(() => {
    const raw = searchParams.get('startDate')
    return raw ? raw.split('T')[0] : ''
  })
  const [filterEndDate, setFilterEndDate] = useState(() => {
    const raw = searchParams.get('endDate')
    return raw ? raw.split('T')[0] : ''
  })

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'dark') {
      root.classList.add('dark')
      root.classList.remove('light')
    } else {
      root.classList.add('light')
      root.classList.remove('dark')
    }
    localStorage.setItem('9drive:theme', theme)
  }, [theme])

  function toggleTheme() {
    setTheme((t) => (t === 'light' ? 'dark' : 'light'))
  }

  async function loadSidebarStats() {
    await Promise.all([
      apiFetch<StorageSummary>('/storage/summary').then(setStorage),
      apiFetch<StorageBreakdown>('/storage/breakdown').then(setBreakdown),
    ])
  }

  async function loadConnectedAccounts() {
    try {
      const data = await apiFetch<{ accounts: ConnectedAccount[] }>('/connected-accounts')
      setAccounts(data.accounts ?? [])
    } catch (e) {
      console.error('Failed to load accounts for filter dropdown', e)
    }
  }

  useEffect(() => {
    setSearchValue(searchParams.get('q') ?? '')
    setFilterKind(searchParams.get('kind') ?? '')
    setFilterAccountId(searchParams.get('accountId') ?? '')
    setFilterMinSize(() => {
      const min = searchParams.get('minSize')
      return min ? String(Math.round(Number(min) / (1024 * 1024))) : ''
    })
    setFilterMaxSize(() => {
      const max = searchParams.get('maxSize')
      return max ? String(Math.round(Number(max) / (1024 * 1024))) : ''
    })

    const rawStart = searchParams.get('startDate')
    setFilterStartDate(rawStart ? rawStart.split('T')[0] : '')

    const rawEnd = searchParams.get('endDate')
    setFilterEndDate(rawEnd ? rawEnd.split('T')[0] : '')
  }, [searchParams])

  async function logout() {
    await apiFetch('/auth/logout', { method: 'POST' }).catch(() => undefined)
    clearAuthSession()
    navigate('/login')
  }

  function applyFilters() {
    const nextParams = new URLSearchParams()
    const activeFolderId = searchParams.get('folderId')
    if (activeFolderId && location.pathname === '/all-files') {
      nextParams.set('folderId', activeFolderId)
    }

    const q = searchValue.trim()
    if (q) nextParams.set('q', q)

    if (filterKind) nextParams.set('kind', filterKind)
    if (filterAccountId) nextParams.set('accountId', filterAccountId)

    if (filterMinSize) {
      const bytes = Number(filterMinSize) * 1024 * 1024
      if (!isNaN(bytes)) nextParams.set('minSize', String(bytes))
    }
    if (filterMaxSize) {
      const bytes = Number(filterMaxSize) * 1024 * 1024
      if (!isNaN(bytes)) nextParams.set('maxSize', String(bytes))
    }

    if (filterStartDate) {
      nextParams.set('startDate', new Date(filterStartDate).toISOString())
    }
    if (filterEndDate) {
      nextParams.set('endDate', new Date(filterEndDate).toISOString())
    }

    setFiltersOpen(false)
    navigate({ pathname: '/all-files', search: nextParams.toString() })
  }

  function clearFilters() {
    setFilterKind('')
    setFilterAccountId('')
    setFilterMinSize('')
    setFilterMaxSize('')
    setFilterStartDate('')
    setFilterEndDate('')
    setFiltersOpen(false)

    const nextParams = new URLSearchParams()
    const activeFolderId = searchParams.get('folderId')
    if (activeFolderId && location.pathname === '/all-files') {
      nextParams.set('folderId', activeFolderId)
    }
    const q = searchValue.trim()
    if (q) nextParams.set('q', q)

    navigate({ pathname: '/all-files', search: nextParams.toString() })
  }

  function searchFiles(event: FormEvent) {
    event.preventDefault()
    setMobileSearchOpen(false)
    applyFilters()
  }

  useEffect(() => {
    apiFetch<{ user: AuthUser }>('/auth/me')
      .then((data) => {
        setUser(data.user)
        updateStoredUser(data.user)
      })
      .catch(() => undefined)
    // Reload BOTH the storage summary and the connected-accounts list so the
    // sidebar quota bar and the "No Drives Connected" state refresh without a
    // hard page reload (OAuth popup handshake, uploads, quota syncs).
    function refreshStorageData() {
      loadSidebarStats().catch(() => undefined)
      loadConnectedAccounts().catch(() => undefined)
    }
    // OAuth popup handshake: the backend callback renders a page that posts
    // UNIDRIVE_OAUTH_SUCCESS to the opener; GoogleConnectedPage posts
    // GOOGLE_CONNECTED. Either message triggers an immediate refetch.
    function onOAuthMessage(event: MessageEvent) {
      const type = event.data?.type
      const succeeded = type === 'UNIDRIVE_OAUTH_SUCCESS' || (type === 'GOOGLE_CONNECTED' && event.data?.status === 'success')
      if (succeeded) refreshStorageData()
    }
    refreshStorageData()
    window.addEventListener('9drive:storage-changed', refreshStorageData)
    window.addEventListener('message', onOAuthMessage)
    return () => {
      window.removeEventListener('9drive:storage-changed', refreshStorageData)
      window.removeEventListener('message', onOAuthMessage)
    }
  }, [])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setInfoOpen(false)
        setMobileSearchOpen(false)
      }
      // ⌘K / Ctrl+K focuses the header search box from anywhere in the app;
      // below sm it opens the compact search overlay first.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (window.matchMedia('(max-width: 639px)').matches) {
          setMobileSearchOpen(true)
        } else {
          searchInputRef.current?.focus()
          searchInputRef.current?.select()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Focus the (already mounted, previously hidden) search input once the compact overlay opens.
  useEffect(() => {
    if (!mobileSearchOpen) return
    searchInputRef.current?.focus()
    searchInputRef.current?.select()
  }, [mobileSearchOpen])

  /** Left-section context label for the top bar, derived from the active route. */
  const headerTitle = (() => {
    const titles: Record<string, string> = {
      '/all-files': 'All Files',
      '/quota': 'Storage Pools',
      '/vault-manifest': 'Vault Manifest',
      '/trash': 'Recycle Bin',
      '/settings': 'Settings',
      '/shared': 'Shared',
      '/recent': 'Recents',
      '/starred': 'Starred',
      '/archived': 'Archived',
      '/activity': 'Activity Log',
      '/api': 'API Management',
    }
    return titles[location.pathname] ?? 'All Files'
  })()

  /**
   * Upload queue rows — exactly ONE row per file identity (name-size).
   * Defensive dedupe across state pipelines (initial map / retry / dismiss)
   * so a file can never render as duplicate shadow cards.
   */
  const uploadQueueRows = (() => {
    const seen = new Set<string>()
    return uploadProgress.files.filter((file) => {
      const key = `${file.name}-${file.size}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  })()

  // Auto-dismiss the drawer 4s after every queued upload has finished (all done
  // / all failed — a stable terminal state), so the panel never lingers. A new
  // batch resets the countdown because the status flips back to uploading.
  const allUploadsSettled = uploadProgress.open && uploadQueueRows.length > 0
    && uploadQueueRows.every((file) => file.status === 'done' || file.status === 'error')
  useEffect(() => {
    if (!allUploadsSettled) return
    const timer = window.setTimeout(() => {
      setUploadProgress((current) => ({ ...current, open: false, errorMessage: undefined }))
    }, 4000)
    return () => window.clearTimeout(timer)
  }, [allUploadsSettled, setUploadProgress])

  return (
    <main className="flex h-screen w-screen overflow-hidden bg-white text-zinc-900 select-none dark:bg-[#090a10] dark:text-zinc-100">
      <div className="flex h-full w-full flex-col overflow-hidden bg-transparent lg:flex-row">
        <div className="hidden h-full shrink-0 lg:block">
          <Sidebar user={user} storage={storage} breakdown={breakdown} onLogout={logout} accountsCount={accounts.length} />
        </div>
        <div className={cn('fixed inset-0 z-40 bg-slate-950/40 backdrop-blur-sm transition-opacity lg:hidden', sidebarOpen ? 'opacity-100' : 'pointer-events-none opacity-0')} onClick={() => setSidebarOpen(false)} />
        <div className={cn('fixed inset-y-0 left-0 z-50 flex w-64 transform flex-col overflow-y-auto border-r border-slate-200/60 bg-white shadow-2xl transition-transform duration-300 ease-out dark:border-zinc-800/60 dark:bg-zinc-950 lg:hidden', sidebarOpen ? 'translate-x-0' : '-translate-x-full')}>
          <div className="absolute right-4 top-4 z-10">
            <Button variant="outline" size="icon" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)}>
              <X className="h-5 w-5" />
            </Button>
          </div>
          <Sidebar user={user} storage={storage} breakdown={breakdown} onLogout={logout} accountsCount={accounts.length} onNavigate={() => setSidebarOpen(false)} />
        </div>
        <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
          <header className="relative z-20 flex h-14 w-full shrink-0 items-center justify-between gap-4 border-b border-zinc-200 bg-white/80 px-4 backdrop-blur-xl lg:px-6 dark:border-white/[0.06] dark:bg-[#090a10]/80">
            {/* Left: hamburger (below lg) · brand (sm–lg) · subtle section label (lg+) — no duplicate bold page title */}
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 lg:hidden dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100" aria-label="Open navigation menu" title="Open menu" onClick={() => setSidebarOpen(true)}>
                <Menu className="h-5 w-5" />
              </Button>
              <div className="hidden shrink-0 items-center gap-2 sm:flex lg:hidden">
                <BrandLogo className="h-8 w-8" />
                <span className="truncate text-lg font-extrabold tracking-tight text-zinc-900 dark:text-zinc-100">UniDrive</span>
              </div>
              <p className="hidden min-w-0 truncate items-center gap-1.5 lg:flex">
                {vaultSectionPaths.has(location.pathname) ? (
                  <>
                    <span className="text-zinc-400 text-xs uppercase tracking-wider font-semibold dark:text-zinc-500">Vault</span>
                    <span className="text-zinc-300 text-xs dark:text-zinc-600">/</span>
                  </>
                ) : null}
                <span className="text-zinc-600 text-sm font-medium dark:text-zinc-300">{headerTitle}</span>
              </p>
            </div>
            {/* Center: prominent, properly centered search (sm+) that collapses into a compact overlay below sm */}
            <div className="flex min-w-0 flex-1 items-center justify-center">
              <div className={cn('relative min-w-0 sm:block', mobileSearchOpen ? 'absolute inset-x-4 top-full z-40 rounded-2xl border border-zinc-200 bg-white/95 p-3 shadow-2xl backdrop-blur-xl sm:relative sm:inset-auto sm:z-auto sm:w-full sm:max-w-xl sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none sm:backdrop-blur-none xl:max-w-2xl dark:border-zinc-800/80 dark:bg-zinc-950/95' : 'hidden w-full max-w-xl xl:max-w-2xl')}>
                <form onSubmit={searchFiles} className="flex h-11 w-full items-center gap-2.5 rounded-xl border border-zinc-200 bg-zinc-100 px-4 text-sm text-zinc-900 shadow-inner transition-all placeholder:text-zinc-400 hover:border-zinc-300 focus-within:border-blue-500/70 focus-within:ring-2 focus-within:ring-blue-500/20 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:hover:border-zinc-700">
                  <Search className="h-4 w-4 shrink-0 text-zinc-400 dark:text-zinc-500" />
                  <Input ref={searchInputRef} value={searchValue} onChange={(event) => setSearchValue(event.target.value)} placeholder="Search files..." className="h-full min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 text-sm text-zinc-900 shadow-none outline-none placeholder:text-zinc-400 focus:border-0 focus:ring-0 dark:bg-transparent dark:text-zinc-100 dark:placeholder:text-zinc-500" />
                  <kbd className="pointer-events-none hidden shrink-0 select-none rounded-md border border-zinc-200 bg-white px-2 py-0.5 text-xs font-semibold text-zinc-400 sm:inline-flex dark:border-zinc-800 dark:bg-zinc-800" aria-hidden="true">{isMacPlatform ? '⌘K' : 'Ctrl K'}</kbd>
                  <button type="button" onClick={() => setFiltersOpen(!filtersOpen)} className={cn('shrink-0 text-zinc-400 transition-colors hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-200', filtersOpen && 'text-blue-500 dark:text-blue-400')} aria-label="Search filters" title="Search filters"><SlidersHorizontal className="h-4 w-4" /></button>
                  <button type="button" onClick={() => { setMobileSearchOpen(false); setFiltersOpen(false) }} className="shrink-0 text-zinc-400 transition-colors hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-200 sm:hidden" aria-label="Close search"><X className="h-4 w-4" /></button>
                </form>

              {filtersOpen && (
                <div className="absolute left-0 right-0 top-full z-50 mt-2 max-h-[70vh] overflow-y-auto rounded-2xl border border-slate-200 bg-white/95 p-5 shadow-2xl backdrop-blur-xl animate-in fade-in slide-in-from-top-2 duration-150 dark:border-zinc-800/80 dark:bg-zinc-900/95">
                  <div className="flex items-center justify-between border-b border-slate-100 pb-3 dark:border-zinc-800/80">
                    <span className="text-sm font-extrabold text-slate-950 dark:text-zinc-100">Advanced Search Filters</span>
                    <button type="button" onClick={clearFilters} className="text-xs font-bold text-blue-600 hover:text-blue-700">Clear All</button>
                  </div>

                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    {/* File Kind */}
                    <div>
                      <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">File Type</label>
                      <select value={filterKind} onChange={(e) => setFilterKind(e.target.value)} className="mt-1 block w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm focus:border-blue-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100 dark:focus:bg-slate-900">
                        <option value="">All Types</option>
                        <option value="image">Image</option>
                        <option value="video">Video</option>
                        <option value="pdf">PDF</option>
                        <option value="doc">Document</option>
                        <option value="archive">Archive</option>
                      </select>
                    </div>

                    {/* Connected Account */}
                    <div>
                      <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Connected Account</label>
                      <select value={filterAccountId} onChange={(e) => setFilterAccountId(e.target.value)} className="mt-1 block w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm focus:border-blue-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100 dark:focus:bg-slate-900">
                        <option value="">All Accounts</option>
                        {accounts.map((acc) => (
                          <option key={acc.id} value={acc.id}>{acc.email} ({acc.provider})</option>
                        ))}
                      </select>
                    </div>

                    {/* Size range */}
                    <div>
                      <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Size Range (MB)</label>
                      <div className="mt-1 flex items-center gap-2">
                        <input type="number" placeholder="Min" value={filterMinSize} onChange={(e) => setFilterMinSize(e.target.value)} className="block w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm focus:border-blue-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100 dark:focus:bg-slate-900" />
                        <span className="text-slate-400 text-xs font-semibold">to</span>
                        <input type="number" placeholder="Max" value={filterMaxSize} onChange={(e) => setFilterMaxSize(e.target.value)} className="block w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm focus:border-blue-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100 dark:focus:bg-slate-900" />
                      </div>
                    </div>

                    {/* Date range */}
                    <div>
                      <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Date Range</label>
                      <div className="mt-1 flex items-center gap-2">
                        <input type="date" value={filterStartDate} onChange={(e) => setFilterStartDate(e.target.value)} className="block w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm focus:border-blue-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100 dark:focus:bg-slate-900" />
                        <span className="text-slate-400 text-xs font-semibold">to</span>
                        <input type="date" value={filterEndDate} onChange={(e) => setFilterEndDate(e.target.value)} className="block w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm focus:border-blue-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100 dark:focus:bg-slate-900" />
                      </div>
                    </div>
                  </div>

                  <div className="mt-5 flex justify-end gap-2 border-t border-slate-100 pt-4">
                    <Button variant="outline" size="sm" type="button" onClick={() => setFiltersOpen(false)}>Cancel</Button>
                    <Button variant="default" size="sm" type="button" onClick={applyFilters}>Apply Filters</Button>
                  </div>
                </div>
              )}
              </div>
              <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 sm:hidden dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100" aria-label="Search files" title="Search files" onClick={() => setMobileSearchOpen(true)}>
                <Search className="h-4 w-4" />
              </Button>
            </div>
            {/* Right: page actions injected by child pages + theme / info cluster */}
            <div className="flex shrink-0 items-center gap-1 sm:gap-2">
              {headerActions}
              <div className="relative flex shrink-0 items-center gap-1 rounded-2xl border border-slate-200/70 bg-white/70 p-1 shadow-sm backdrop-blur-md dark:border-zinc-800/80 dark:bg-zinc-900/60">
                <Button variant="ghost" size="icon" className="h-9 w-9 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100" aria-label="Toggle theme" title="Toggle theme" onClick={toggleTheme}>
                  {theme === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
                </Button>
                <Button variant="ghost" size="icon" className="relative hidden h-9 w-9 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 sm:inline-flex" aria-label="System info" title="Workspace status & info" aria-expanded={infoOpen} onClick={() => setInfoOpen(!infoOpen)}>
                  <Bell className="h-4 w-4" />
                  {!infoOpen ? <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-blue-500" /> : null}
                </Button>
                {infoOpen ? <SystemInfoDropdown storage={storage} /> : null}
              </div>
            </div>
          </header>
          <section className="min-w-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6 lg:p-8">
            <Outlet context={{ setHeaderActions } satisfies DriveLayoutContext} />
          </section>
        </div>
      </div>

      {uploadProgress.open ? (
        <div className="fixed inset-x-3 bottom-3 z-[70] max-w-md max-h-[70dvh] overflow-hidden rounded-2xl border border-slate-200/80 bg-white/90 shadow-2xl shadow-slate-900/20 backdrop-blur-xl dark:border-zinc-800/80 dark:bg-zinc-950/80 dark:shadow-black/60 sm:inset-x-auto sm:bottom-5 sm:right-5 sm:w-[min(420px,calc(100vw-2.5rem))]">
          <div className="flex items-center justify-between border-b border-slate-200/80 px-4 py-3 dark:border-zinc-800/80">
            <div className="flex items-center gap-2 font-extrabold text-sm text-slate-950 dark:text-slate-100">
              {uploadProgress.status === 'done' ? <CheckCircle className="h-5 w-5 text-emerald-500" /> : uploadProgress.status === 'partial' || uploadProgress.status === 'error' ? <X className="h-5 w-5 text-red-500" /> : <Upload className="h-5 w-5 text-blue-600" />}
              {uploadProgress.status === 'done' ? 'Upload complete' : uploadProgress.status === 'partial' ? 'Upload completed with errors' : uploadProgress.status === 'error' ? 'Upload failed' : uploadProgress.percent >= 99 ? 'Processing on server' : 'Uploading files'}
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setUploadProgressCollapsed(!uploadProgressCollapsed)}><ChevronDown className={cn("h-4 w-4 transition-transform", uploadProgressCollapsed && "rotate-180")} /></Button>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setUploadProgress((current) => ({ ...current, open: false }))}><X className="h-4 w-4" /></Button>
            </div>
          </div>
          {uploadProgress.errorMessage && !uploadProgressCollapsed ? (
            <div className="mx-4 mt-3 flex items-start gap-2 rounded-xl bg-red-500/10 px-3 py-2.5 text-[12px] font-semibold text-red-600 dark:text-red-400">
              <span className="min-w-0 flex-1 break-words whitespace-normal">{uploadProgress.errorMessage}</span>
              <button
                type="button"
                aria-label="Dismiss error message"
                onClick={() => setUploadProgress((current) => ({ ...current, errorMessage: undefined }))}
                className="shrink-0 rounded-md p-0.5 text-red-500/70 transition hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-300"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}
          {!uploadProgressCollapsed && uploadQueueRows.length > 0 ? (
            <div className="grid max-h-64 gap-2 overflow-y-auto p-4 pr-1">
              {uploadQueueRows.map((file) => (
                <div key={`${file.name}-${file.size}`} className="rounded-xl border border-slate-200/70 bg-slate-50/70 px-3 py-2.5 backdrop-blur-sm dark:border-zinc-800/80 dark:bg-zinc-900/40">
                  {/* Line 1: status icon · file name · size — percentage pinned far right */}
                  <div className="flex min-w-0 items-center gap-2.5">
                    {file.status === 'done' ? (
                      <CheckCircle className="h-4 w-4 shrink-0 text-emerald-500" />
                    ) : file.status === 'error' ? (
                      <X className="h-4 w-4 shrink-0 text-red-500" />
                    ) : (
                      <Upload className="h-4 w-4 shrink-0 animate-pulse text-blue-500" />
                    )}
                    <span className="min-w-0 flex-1 max-w-[240px] sm:max-w-[280px] truncate text-[13px] font-semibold text-slate-900 dark:text-zinc-100" title={file.name}>{file.name}</span>
                    <span className="ml-auto shrink-0 text-[11px] tabular-nums text-slate-500 dark:text-zinc-400">
                      {file.status !== 'error' && typeof file.loadedBytes === 'number' && file.loadedBytes > 0 && file.loadedBytes < file.size
                        ? `${formatBytes(file.loadedBytes)} / ${formatBytes(file.size)}`
                        : formatBytes(file.size)}
                    </span>
                    <span className="w-9 shrink-0 text-right text-[11px] font-semibold tabular-nums text-slate-600 dark:text-zinc-300">{file.percent}%</span>
                  </div>
                  {/* Line 2: sleek 4px progress bar — pulses while uploading, red tint on failure */}
                  <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-slate-200/80 dark:bg-zinc-800">
                    <div
                      className={file.status === 'error'
                        ? 'h-full rounded-full bg-red-500/80'
                        : file.status === 'done'
                          ? 'h-full rounded-full bg-emerald-500'
                          : 'h-full rounded-full bg-blue-500 animate-pulse'}
                      style={{ width: `${file.percent}%` }}
                    />
                  </div>
                  {/* Line 3: failed rows get a wrapping, clamped error + inline Details/Retry/Dismiss; healthy rows show chunk info + badge. */}
                  {file.status === 'error' ? (
                    <div className="mt-1.5 flex items-start justify-between gap-2">
                      <span className={cn(
                        'min-w-0 flex-1 text-xs text-rose-400 mt-1 leading-relaxed break-words whitespace-normal',
                        expandedUploadErrors[`${file.name}-${file.size}`] ? '' : 'line-clamp-2'
                      )}>
                        {file.errorMessage && file.errorMessage !== uploadProgress.errorMessage ? file.errorMessage : 'Upload failed'}
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          aria-label={`Toggle full error details for ${file.name}`}
                          onClick={() => setExpandedUploadErrors((current) => ({ ...current, [`${file.name}-${file.size}`]: !current[`${file.name}-${file.size}`] }))}
                          className="rounded-md px-1.5 py-1 text-[10px] font-bold text-slate-500 transition hover:bg-red-500/10 hover:text-red-600 dark:text-zinc-400 dark:hover:text-red-400"
                        >
                          {expandedUploadErrors[`${file.name}-${file.size}`] ? 'Less' : 'Details'}
                        </button>
                        <button
                          type="button"
                          aria-label={`Retry ${file.name}`}
                          onClick={() => retryFailedUpload(file.name)}
                          className="rounded-md p-1 text-slate-500 transition hover:bg-red-500/10 hover:text-red-600 dark:text-zinc-400 dark:hover:text-red-400"
                        >
                          <RotateCw className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Dismiss ${file.name}`}
                          onClick={() => setUploadProgress((current) => ({ ...current, files: current.files.filter((entry) => !(entry.name === file.name && entry.size === file.size)) }))}
                          className="rounded-md p-1 text-slate-500 transition hover:bg-red-500/10 hover:text-red-600 dark:text-zinc-400 dark:hover:text-red-400"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                        <span className="rounded-md bg-red-500/10 px-1.5 py-0.5 text-[10px] font-bold text-red-600 dark:text-red-400">Failed</span>
                      </span>
                    </div>
                  ) : (
                    <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-zinc-400">
                      <span className="min-w-0 truncate">
                        {file.chunkTotal && file.chunkTotal > 1
                          ? `Chunk ${Math.min(file.chunkIndex ?? 1, file.chunkTotal)} of ${file.chunkTotal}${file.provider ? ` · ${file.provider}` : ''}`
                          : (file.provider ? `Targeting ${file.provider}` : '')}
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        {file.status === 'done' ? (
                          <span className="flex items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
                            <CheckCircle className="h-3 w-3" />Completed
                          </span>
                        ) : file.phase === 'saving' || file.percent >= 99 ? (
                          <span className="flex items-center gap-1 text-[10px] font-semibold text-indigo-600 dark:text-indigo-400">
                            <Loader2 className="h-3 w-3 animate-spin" />Saving to Google Drive...
                          </span>
                        ) : (
                          <span className="text-[10px] font-semibold text-blue-600 dark:text-blue-400">Uploading</span>
                        )}
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </main>
  )
}
