import { google } from 'googleapis'
import type { ConnectedAccount, ProviderConfig } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { decryptText, encryptText } from '../../utils/crypto.js'

const googleDriveFolderMimeType = 'application/vnd.google-apps.folder'
/** Isolated app root folder in Google Drive. Every upload, chunk and manifest lives inside it. */
export const appFolderName = 'UniDrive'

export function createOAuthClient(config: ProviderConfig) {
  return new google.auth.OAuth2(decryptText(config.clientIdEncrypted), decryptText(config.clientSecretEncrypted), config.redirectUri)
}

/**
 * Per-account in-memory locks around Google token refreshes.
 * Concurrent chunk streams for the same account share ONE refresh request
 * instead of racing simultaneous refreshes (which can invalidate tokens and
 * trigger Google rate limits / invalid_grant errors).
 */
const tokenRefreshLocks = new Map<string, Promise<void>>()

async function refreshGoogleAccessToken(accountId: string): Promise<void> {
  const existing = tokenRefreshLocks.get(accountId)
  if (existing) return existing

  const lock = (async () => {
    // Re-read inside the lock: an earlier waiter may have refreshed already.
    const fresh = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: accountId } })
    if (fresh.tokenExpiresAt && fresh.tokenExpiresAt.getTime() >= Date.now() + 60_000) return
    if (!fresh.accessTokenEncrypted || !fresh.refreshTokenEncrypted || !fresh.tokenExpiresAt) throw new Error('Google account tokens are missing.')
    if (!fresh.providerConfigId) throw new Error('Google provider config is missing.')

    const config = await prisma.providerConfig.findUniqueOrThrow({ where: { id: fresh.providerConfigId } })
    const client = createOAuthClient(config)
    client.setCredentials({
      access_token: decryptText(fresh.accessTokenEncrypted),
      refresh_token: decryptText(fresh.refreshTokenEncrypted),
      expiry_date: fresh.tokenExpiresAt.getTime(),
    })

    const result = await client.refreshAccessToken()
    const credentials = result.credentials
    if (credentials.access_token) {
      await prisma.connectedAccount.update({
        where: { id: accountId },
        data: {
          accessTokenEncrypted: encryptText(credentials.access_token),
          tokenExpiresAt: new Date(credentials.expiry_date ?? Date.now() + 3600_000),
        },
      })
    }
  })()

  tokenRefreshLocks.set(accountId, lock)
  try {
    await lock
  } finally {
    tokenRefreshLocks.delete(accountId)
  }
}

export async function getAuthedGoogleClient(account: ConnectedAccount) {
  if (!account.accessTokenEncrypted || !account.refreshTokenEncrypted || !account.tokenExpiresAt) throw new Error('Google account tokens are missing.')
  if (!account.providerConfigId) throw new Error('Google provider config is missing.')
  const config = await prisma.providerConfig.findUniqueOrThrow({ where: { id: account.providerConfigId } })
  const client = createOAuthClient(config)
  client.setCredentials({
    access_token: decryptText(account.accessTokenEncrypted),
    refresh_token: decryptText(account.refreshTokenEncrypted),
    expiry_date: account.tokenExpiresAt.getTime(),
  })

  if (account.tokenExpiresAt.getTime() < Date.now() + 60_000) {
    // Shared lock: concurrent callers wait for the single in-flight refresh.
    await refreshGoogleAccessToken(account.id)
    // Load the freshly persisted tokens so every caller gets the new access token.
    const refreshed = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: account.id } })
    if (refreshed.accessTokenEncrypted && refreshed.refreshTokenEncrypted && refreshed.tokenExpiresAt) {
      client.setCredentials({
        access_token: decryptText(refreshed.accessTokenEncrypted),
        refresh_token: decryptText(refreshed.refreshTokenEncrypted),
        expiry_date: refreshed.tokenExpiresAt.getTime(),
      })
    }
  }

  return client
}

export async function syncGoogleQuota(accountId: string) {
  const account = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: accountId } })
  const auth = await getAuthedGoogleClient(account)
  const drive = google.drive({ version: 'v3', auth })
  const about = await drive.about.get({ fields: 'storageQuota,user' })
  const quota = about.data.storageQuota
  const total = quota?.limit ? BigInt(quota.limit) : null
  const used = quota?.usage ? BigInt(quota.usage) : 0n
  return prisma.storageAccount.upsert({
    where: { connectedAccountId: accountId },
    create: {
      connectedAccountId: accountId,
      totalBytes: total,
      usedBytes: used,
      availableBytes: total === null ? null : total - used,
      trashBytes: quota?.usageInDriveTrash ? BigInt(quota.usageInDriveTrash) : null,
      lastSyncedAt: new Date(),
    },
    update: {
      totalBytes: total,
      usedBytes: used,
      availableBytes: total === null ? null : total - used,
      trashBytes: quota?.usageInDriveTrash ? BigInt(quota.usageInDriveTrash) : null,
      lastSyncedAt: new Date(),
    },
  })
}

function escapeDriveQueryValue(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export async function ensureGoogleAppFolder(account: ConnectedAccount) {
  const auth = await getAuthedGoogleClient(account)
  const drive = google.drive({ version: 'v3', auth })
  const queryName = escapeDriveQueryValue(appFolderName)
  const existing = await drive.files.list({
    q: `name = '${queryName}' and mimeType = '${googleDriveFolderMimeType}' and 'root' in parents and trashed = false`,
    spaces: 'drive',
    fields: 'files(id,name)',
    pageSize: 1,
  })
  const folderId = existing.data.files?.[0]?.id ?? (await drive.files.create({
    requestBody: { name: appFolderName, mimeType: googleDriveFolderMimeType, parents: ['root'] },
    fields: 'id',
  })).data.id

  if (!folderId) throw new Error('Failed to create Google Drive app folder.')
  return folderId
}

export type GoogleAppFolderSyncResult = {
  accountId: string
  created: number
  updated: number
  deleted: number
}

type DriveFileMetadata = {
  id: string
  name: string
  mimeType: string
  sizeBytes: bigint
  parentId: string
  thumbnailUrl?: string | null
}

export async function syncGoogleAppFolderFiles(accountId: string, userId: string): Promise<GoogleAppFolderSyncResult> {
  const account = await prisma.connectedAccount.findFirstOrThrow({ where: { id: accountId, userId, provider: 'google_drive', status: 'connected' } })
  const auth = await getAuthedGoogleClient(account)
  const drive = google.drive({ version: 'v3', auth })
  const appFolderId = await ensureGoogleAppFolder(account)

  const userFolders = await prisma.folder.findMany({
    where: { userId, connectedAccountId: account.id, deletedAt: null },
    select: { id: true, providerFolderId: true }
  })
  const parentIds = [
    appFolderId,
    ...userFolders.map((f) => f.providerFolderId).filter((id): id is string => !!id)
  ]

  const driveFiles: DriveFileMetadata[] = []
  let pageToken: string | undefined

  const parentsQuery = parentIds.map((id) => `'${id}' in parents`).join(' or ')
  const q = `(${parentsQuery}) and mimeType != '${googleDriveFolderMimeType}' and trashed = false`

  do {
    const response = await drive.files.list({
      q,
      spaces: 'drive',
      fields: 'nextPageToken,files(id,name,mimeType,size,parents,thumbnailLink)',
      pageSize: 1000,
      pageToken,
    })
    for (const file of response.data.files ?? []) {
      if (!file.id || !file.name || !file.mimeType) continue
      const parentId = file.parents?.[0] ?? appFolderId
      driveFiles.push({ id: file.id, name: file.name, mimeType: file.mimeType, sizeBytes: BigInt(file.size ?? 0), parentId, thumbnailUrl: file.thumbnailLink ?? null })
    }
    pageToken = response.data.nextPageToken ?? undefined
  } while (pageToken)

  const existingFiles = await prisma.file.findMany({ where: { userId, connectedAccountId: account.id, provider: 'google_drive' } })
  const existingByProviderId = new Map(existingFiles.map((file) => [file.providerFileId, file]))
  const driveFileIds = new Set(driveFiles.map((file) => file.id))
  let created = 0
  let updated = 0
  let deleted = 0

  const folderIdMap = new Map(userFolders.map((f) => [f.providerFolderId, f.id]))

  for (const driveFile of driveFiles) {
    // Skip UniDrive chunk parts — they are indexed as FileChunk rows, not Drive files.
    if (/\.vaultrz\d{4}$/.test(driveFile.name)) continue
    const dbFolderId = driveFile.parentId === appFolderId ? null : (folderIdMap.get(driveFile.parentId) ?? null)
    const existing = existingByProviderId.get(driveFile.id)
    if (!existing) {
      await prisma.file.create({
        data: { userId, connectedAccountId: account.id, provider: 'google_drive', providerFileId: driveFile.id, name: driveFile.name, mimeType: driveFile.mimeType, sizeBytes: driveFile.sizeBytes, thumbnailUrl: driveFile.thumbnailUrl ?? null, status: 'active', folderId: dbFolderId },
      })
      created += 1
      continue
    }

    const needsUpdate = existing.name !== driveFile.name || existing.mimeType !== driveFile.mimeType || existing.sizeBytes !== driveFile.sizeBytes || existing.status !== 'active' || existing.deletedAt !== null || existing.folderId !== dbFolderId || (driveFile.thumbnailUrl && existing.thumbnailUrl !== driveFile.thumbnailUrl)
    if (needsUpdate) {
      await prisma.file.update({
        where: { id: existing.id },
        data: { name: driveFile.name, mimeType: driveFile.mimeType, sizeBytes: driveFile.sizeBytes, thumbnailUrl: driveFile.thumbnailUrl ?? existing.thumbnailUrl, status: 'active', deletedAt: null, folderId: dbFolderId },
      })
      updated += 1
    }
  }

  const missingActiveIds = existingFiles.filter((file) => file.status === 'active' && !driveFileIds.has(file.providerFileId)).map((file) => file.id)
  if (missingActiveIds.length > 0) {
    const result = await prisma.file.updateMany({ where: { id: { in: missingActiveIds }, userId }, data: { status: 'deleted', deletedAt: new Date() } })
    deleted = result.count
  }

  await syncGoogleQuota(account.id).catch(() => undefined)
  return { accountId: account.id, created, updated, deleted }
}
