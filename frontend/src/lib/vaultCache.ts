/**
 * Session-level cache for folder/file listings (an SWR-style store).
 *
 * Navigating between folders previously triggered duplicate network waterfalls on
 * every entry/exit. This cache keeps the last-fetched `{ files, folders }` for
 * each folder scope keyed by the query signature, so revisiting a folder renders
 * instantly (0ms, no flash) while a background revalidation refreshes the data.
 *
 * Key = the query string used to fetch (e.g. `folderId=null`, `folderId=<id>`),
 * so search/filter variations get their own cache entries.
 *
 * Cached values are the fully-mapped UI items (FileItem[]/FolderItem[]) whose
 * date fields are already formatted strings. They are stored by reference in an
 * in-memory Map and returned untouched — no JSON round-trip, no date mutation or
 * stripping — so a cache hit renders exactly what was originally produced.
 */

const filesCache = new Map<string, { files: unknown[] }>()
const foldersCache = new Map<string, { folders: unknown[] }>()

export function getCachedFiles<T>(key: string): { files: T[] } | undefined {
  return filesCache.get(key) as { files: T[] } | undefined
}

export function setCachedFiles(key: string, value: { files: unknown[] }): void {
  filesCache.set(key, value)
}

export function getCachedFolders<T>(key: string): { folders: T[] } | undefined {
  return foldersCache.get(key) as { folders: T[] } | undefined
}

export function setCachedFolders(key: string, value: { folders: unknown[] }): void {
  foldersCache.set(key, value)
}

/** Invalidate everything (call after create/rename/move/delete/upload/sync). */
export function invalidateVaultCache(): void {
  filesCache.clear()
  foldersCache.clear()
}
