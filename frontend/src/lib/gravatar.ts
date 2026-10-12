// Generates a fun, unique avatar URL for a user based on their email.
//
// IMPORTANT: this must NOT probe gravatar.com. The previous implementation fired
// a `fetch(..., { method: 'HEAD' })` against Gravatar for every user, which logged
// a 404 in the console for everyone without a Gravatar image (a "404 storm"). We
// instead resolve directly to a DiceBear "bottts" avatar that ALWAYS returns an
// image, so there is zero gravatar.com traffic and zero 404s. Callers render the
// result in an <img onError> that falls back to an initials badge if even DiceBear
// is unreachable (e.g. offline), so the avatar never breaks.
export async function getGravatarUrl(email: string | undefined, size: number): Promise<string> {
  const normalized = email?.trim().toLowerCase()
  const seed = normalized ?? 'default-user'

  // Hash the email to seed the avatar (SHA-256 when available, else a small hash).
  let hash = ''
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed))
      hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
    } catch {
      hash = simpleHash(seed)
    }
  } else {
    hash = simpleHash(seed)
  }

  // DiceBear bottts — cute, colorful robot avatars (deterministic per email hash).
  return `https://api.dicebear.com/8.x/bottts/svg?seed=${encodeURIComponent(hash)}&size=${size}&backgroundColor=b6e3f4,c0aede,d1f4cc,ffdfbf,ffd5dc`
}

function simpleHash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i)
    hash |= 0 // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36)
}
