import crypto from 'node:crypto'
import { google } from 'googleapis'
import { HeadObjectCommand } from '@aws-sdk/client-s3'
import type { ConnectedAccount, FileChunk, VirtualFile } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { env } from '../../config/env.js'
import { appFolderName, getAuthedGoogleClient } from '../google/google.service.js'
import { createS3Client, getS3ConfigForAccount } from '../s3/s3.service.js'
import { decryptKeyringValue, encryptKeyringValue } from './vault.service.js'
import { decryptText, encryptText } from '../../utils/crypto.js'

export const VAULT_MANIFEST_NAME = '.vault_manifest.json'
export const VAULT_MANIFEST_VERSION = 1

export type ManifestChunk = {
  chunkIndex: number
  size: string
  providerEmail: string
  remoteFileId: string
}

export type ManifestFile = {
  id: string
  fileId: string | null
  name: string
  virtualPath: string
  totalSize: string
  mimeType: string
  isChunked: boolean
  status: string
  createdAt: string
  updatedAt: string
  chunks: ManifestChunk[]
}

export type ManifestAccount = {
  id: string
  provider: string
  providerAccountId: string
  email: string
  displayName: string | null
  /** AES-256-GCM(iv:tag:cipher) with the per-user vault master key. */
  refreshTokenEnc: string | null
  accessTokenEnc: string | null
}

export type VaultManifest = {
  version: number
  name: typeof VAULT_MANIFEST_NAME
  appFolder: string
  createdAt: string
  updatedAt: string
  files: ManifestFile[]
  accounts: ManifestAccount[]
}

/**
 * Derives the per-user AES-256 master key used by the `.vault_manifest.json`
 * keyring. Never persisted; only derived from server secrets + user id.
 */
export function deriveVaultMasterKey(userId: string): Buffer {
  return crypto.createHash('sha256').update(env.TOKEN_ENCRYPTION_KEY).update(`:vault:${userId}`).digest()
}

function serializeChunk(row: FileChunk): ManifestChunk {
  return { chunkIndex: row.chunkIndex, size: row.size.toString(), providerEmail: row.providerEmail, remoteFileId: row.remoteFileId }
}

/** Reads the full vault state (virtual files, chunks, accounts) and seals it into a manifest. */
export async function buildVaultManifest(userId: string, now = new Date()): Promise<VaultManifest> {
  const vaultKey = deriveVaultMasterKey(userId)
  const [virtualFiles, accounts] = await Promise.all([
    prisma.virtualFile.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    prisma.connectedAccount.findMany({ where: { userId, status: 'connected' }, orderBy: { createdAt: 'asc' } }),
  ])
  const chunkRows = await prisma.fileChunk.findMany({ where: { fileId: { in: virtualFiles.map((file) => file.id) } }, orderBy: { chunkIndex: 'asc' } })
  const chunksByFile = new Map<string, ManifestChunk[]>()
  for (const row of chunkRows) {
    const list = chunksByFile.get(row.fileId) ?? []
    list.push(serializeChunk(row))
    chunksByFile.set(row.fileId, list)
  }

  const files: ManifestFile[] = virtualFiles.map((file) => ({
    id: file.id,
    fileId: file.fileId,
    name: file.name,
    virtualPath: file.virtualPath,
    totalSize: file.totalSize.toString(),
    mimeType: file.mimeType,
    isChunked: file.isChunked,
    status: file.status,
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
    chunks: chunksByFile.get(file.id) ?? [],
  }))

  const manifestAccounts: ManifestAccount[] = accounts.map((account) => ({
    id: account.id,
    provider: account.provider,
    providerAccountId: account.providerAccountId,
    email: account.email,
    displayName: account.displayName,
    refreshTokenEnc: account.refreshTokenEncrypted ? encryptKeyringValue(decryptRefreshToken(account), vaultKey) : null,
    accessTokenEnc: account.accessTokenEncrypted ? encryptKeyringValue(decryptAccessToken(account), vaultKey) : null,
  }))

  return {
    version: VAULT_MANIFEST_VERSION,
    name: VAULT_MANIFEST_NAME,
    appFolder: appFolderName,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    files,
    accounts: manifestAccounts,
  }
}

/** Tokens are already encrypted at rest by `utils/crypto.ts`; unwrap before re-sealing for the manifest. */
function decryptRefreshToken(account: ConnectedAccount): string {
  return decryptText(account.refreshTokenEncrypted as string)
}

function decryptAccessToken(account: ConnectedAccount): string {
  return decryptText(account.accessTokenEncrypted as string)
}

/**
 * Checks whether one physical chunk object still exists on its provider.
 * Returns 'unverified' when the account is disconnected or the check failed
 * for a non-404 reason (never treat transient errors as data loss).
 */
async function chunkExists(account: ConnectedAccount | null, remoteFileId: string): Promise<boolean | 'unverified'> {
  if (!account || account.status !== 'connected') return 'unverified'
  try {
    if (account.provider === 'google_drive') {
      const auth = await getAuthedGoogleClient(account)
      const drive = google.drive({ version: 'v3', auth })
      await drive.files.get({ fileId: remoteFileId, fields: 'id', supportsAllDrives: true })
      return true
    }
    const config = await getS3ConfigForAccount(account.id)
    const client = createS3Client(config)
    await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: remoteFileId }))
    return true
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number }; name?: string }).$metadata?.httpStatusCode
    const name = (error as { name?: string }).name
    if (status === 404 || name === 'NotFound' || name === 'NoSuchKey') return false
    if (status === 410) return false
    return 'unverified'
  }
}

export type ManifestSyncReport = {
  totalFiles: number
  totalChunks: number
  verifiedChunks: number
  missingChunks: { virtualFileId: string; chunkIndex: number; providerEmail: string; remoteFileId: string }[]
  lostFiles: string[]
  unverifiedChunks: number
  syncedAt: string
}

/**
 * Verifies every recorded chunk against its physical provider and marks files
 * whose objects vanished as `lost` (never deletes rows — recovery stays possible
 * after a re-upload or a provider-side restore).
 */
export async function syncVaultManifest(userId: string, manifest: VaultManifest): Promise<ManifestSyncReport> {
  const accounts = await prisma.connectedAccount.findMany({ where: { userId } })
  const accountByEmail = new Map(accounts.map((account) => [account.email, account] as const))
  const report: ManifestSyncReport = {
    totalFiles: manifest.files.length,
    totalChunks: 0,
    verifiedChunks: 0,
    missingChunks: [],
    lostFiles: [],
    unverifiedChunks: 0,
    syncedAt: new Date().toISOString(),
  }

  for (const file of manifest.files) {
    let hasMissingChunk = false
    for (const chunk of file.chunks) {
      report.totalChunks += 1
      const exists = await chunkExists(accountByEmail.get(chunk.providerEmail) ?? null, chunk.remoteFileId)
      if (exists === true) report.verifiedChunks += 1
      else if (exists === 'unverified') report.unverifiedChunks += 1
      else {
        report.missingChunks.push({ virtualFileId: file.id, chunkIndex: chunk.chunkIndex, providerEmail: chunk.providerEmail, remoteFileId: chunk.remoteFileId })
        hasMissingChunk = true
      }
    }
    if (hasMissingChunk) {
      report.lostFiles.push(file.id)
      await prisma.virtualFile.updateMany({ where: { id: file.id, userId, status: 'active' }, data: { status: 'lost' } })
    }
  }
  return report
}


export type ManifestRestoreReport = {
  restoredFiles: number
  restoredChunks: number
  adoptedAccounts: number
  skippedAccounts: number
}

function isVaultManifest(value: unknown): value is VaultManifest {
  const candidate = value as VaultManifest | null
  return (
    !!candidate &&
    typeof candidate === 'object' &&
    candidate.version === VAULT_MANIFEST_VERSION &&
    Array.isArray(candidate.files) &&
    Array.isArray(candidate.accounts)
  )
}

/**
 * Rebuilds `VirtualFile` / `FileChunk` rows from a previously exported manifest
 * (disaster recovery). Optionally adopts sealed keyring accounts: encrypted
 * refresh tokens are unwrapped with the vault master key and connected accounts
 * that no longer exist locally are recreated in `status: 'pending'` so tokens
 * are never auto-trusted without a health check.
 */
export async function restoreVaultManifest(userId: string, rawManifest: unknown, options: { adoptAccounts?: boolean } = {}): Promise<ManifestRestoreReport> {
  if (!isVaultManifest(rawManifest)) throw new Error('Invalid vault manifest: unsupported version or shape.')
  const vaultKey = deriveVaultMasterKey(userId)
  const report: ManifestRestoreReport = { restoredFiles: 0, restoredChunks: 0, adoptedAccounts: 0, skippedAccounts: 0 }

  for (const file of rawManifest.files) {
    await prisma.virtualFile.upsert({
      where: { id: file.id },
      create: {
        id: file.id,
        userId,
        fileId: file.fileId,
        name: file.name,
        virtualPath: file.virtualPath,
        totalSize: BigInt(file.totalSize),
        mimeType: file.mimeType,
        isChunked: file.isChunked,
        status: file.status,
        createdAt: new Date(file.createdAt),
        updatedAt: new Date(file.updatedAt),
      },
      update: { name: file.name, virtualPath: file.virtualPath, totalSize: BigInt(file.totalSize), mimeType: file.mimeType, isChunked: file.isChunked },
    })
    report.restoredFiles += 1
    for (const chunk of file.chunks) {
      await prisma.fileChunk.upsert({
        where: { fileId_chunkIndex: { fileId: file.id, chunkIndex: chunk.chunkIndex } },
        create: { fileId: file.id, chunkIndex: chunk.chunkIndex, size: BigInt(chunk.size), providerEmail: chunk.providerEmail, remoteFileId: chunk.remoteFileId },
        update: { size: BigInt(chunk.size), providerEmail: chunk.providerEmail, remoteFileId: chunk.remoteFileId },
      })
      report.restoredChunks += 1
    }
  }

  if (options.adoptAccounts) {
    for (const account of rawManifest.accounts) {
      const existing = await prisma.connectedAccount.findUnique({
        where: { userId_provider_providerAccountId: { userId, provider: account.provider, providerAccountId: account.providerAccountId } },
      })
      if (existing) {
        report.skippedAccounts += 1
        continue
      }
      await prisma.connectedAccount.create({
        data: {
          userId,
          provider: account.provider,
          providerAccountId: account.providerAccountId,
          email: account.email,
          displayName: account.displayName,
          status: 'pending',
          scopes: [],
          refreshTokenEncrypted: account.refreshTokenEnc ? encryptText(decryptKeyringValue(account.refreshTokenEnc, vaultKey)) : null,
          accessTokenEncrypted: account.accessTokenEnc ? encryptText(decryptKeyringValue(account.accessTokenEnc, vaultKey)) : null,
        },
      })
      report.adoptedAccounts += 1
    }
  }
  return report
}

