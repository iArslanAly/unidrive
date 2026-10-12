import { clearAuthSession, getAccessToken, getRefreshToken, setAccessToken } from '@/lib/auth'

const isProd = import.meta.env.PROD
const rawApiUrl = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '')
/** Backend base URL — all routes are served under /api (no hardcoded ports). */
export const API_URL = rawApiUrl || (isProd ? '/api' : 'http://localhost:45450/api')


type ApiOptions = RequestInit & { skipAuth?: boolean; retry?: boolean }

// Single in-flight refresh shared by all concurrent 401s. Without this, parallel
// requests that all see an expired token each fire their own /auth/refresh; since
// refresh tokens are single-use, the first invalidates the rest and they cascade
// into a 401 "waterfall". Deduping means exactly one refresh happens per expiry.
let refreshInFlight: Promise<boolean> | null = null

function refreshAccessToken() {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    const refreshToken = getRefreshToken()
    if (!refreshToken) return false
    let response: Response
    try {
      response = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      })
    } catch {
      return false
    }
    if (!response.ok) return false
    const data = await response.json() as { accessToken: string }
    setAccessToken(data.accessToken)
    return true
  })().finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}

export async function apiFetch<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers = new Headers(options.headers)
  const token = getAccessToken()
  if (!options.skipAuth && token) headers.set('Authorization', `Bearer ${token}`)
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

  // Convert raw "NetworkError when attempting to fetch resource" (backend down /
  // wrong port) into a clean, actionable message instead of letting it surface
  // as a browser-level error string.
  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, { ...options, headers })
  } catch {
    throw new Error(`Cannot reach the UniDrive backend at ${API_URL}. Make sure it is running (cd backend && npm run dev).`)
  }
  if (response.status === 401 && options.retry !== false && !options.skipAuth && await refreshAccessToken()) {
    return apiFetch<T>(path, { ...options, retry: false })
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }))
    if (response.status === 401) clearAuthSession()
    throw new Error(error.message ?? 'Request failed')
  }

  return response.json() as Promise<T>
}

export function formatBytes(input: string | number | bigint | null | undefined) {
  if (input === null || input === undefined) return '--'
  const bytes = Number(input)
  if (!Number.isFinite(bytes)) return '--'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 2)} ${units[index]}`
}

/**
 * Bulletproof date formatter. Vault data can arrive with null/undefined/NaN
 * timestamps (missing DB columns, cache round-trips, malformed rows), and calling
 * `Intl.DateTimeFormat().format()` on an invalid Date throws
 * "RangeError: date value is not finite". This guards every path and falls back
 * to an em dash so a single bad date never crashes the whole page render.
 */
export function formatDate(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  const parsed = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(parsed.getTime())) return '—'
  try {
    return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(parsed)
  } catch {
    return '—'
  }
}
