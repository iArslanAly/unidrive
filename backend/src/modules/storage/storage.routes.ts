import { Router, type NextFunction, type Response } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'

export const storageRouter = Router()
storageRouter.use(requireAuth)

type BreakdownRow = { kind: string; bytes: bigint | number | string | null }

function bytesToString(value: bigint | number | string | null | undefined) {
  if (value === null || value === undefined) return '0'
  return value.toString()
}

// ---------------------------------------------------------------------------
// Upload routing policy
// ---------------------------------------------------------------------------
// Canonical modes: 'auto' (Smart Auto), 'priority' (Priority Waterfall),
// 'rules' (Rule-Based). Older builds stored 'most_available' / 'round_robin';
// those values are normalized to 'auto' on read/write so existing rows keep
// working without a data migration.
const routingModes = ['auto', 'priority', 'rules'] as const
const legacyRoutingModes = ['most_available', 'round_robin'] as const
type RoutingMode = (typeof routingModes)[number]
type RoutingTypeRules = { video?: string; document?: string; default?: string }

const routingPolicySchema = z.object({
  mode: z.enum([...routingModes, ...legacyRoutingModes]),
  // New name for the Priority Waterfall order.
  priorityOrder: z.array(z.string().min(1)).max(100).optional(),
  // Legacy alias accepted so older clients keep working.
  priorityAccountIds: z.array(z.string().min(1)).max(100).optional(),
  safetyCapPercent: z.number().int().min(1).max(100).optional(),
  typeRules: z
    .object({
      video: z.string().min(1).optional(),
      document: z.string().min(1).optional(),
      default: z.string().min(1).optional(),
    })
    .optional(),
})

function normalizeMode(value: unknown): RoutingMode {
  return value === 'priority' || value === 'rules' ? value : 'auto'
}

function normalizeStringList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** Keeps only the known rule kinds with non-empty string account ids. */
function normalizeTypeRules(value: unknown): RoutingTypeRules {
  if (!value || typeof value !== 'object') return {}
  const raw = value as Record<string, unknown>
  const rules: RoutingTypeRules = {}
  for (const key of ['video', 'document', 'default'] as const) {
    if (typeof raw[key] === 'string' && raw[key]) rules[key] = raw[key] as string
  }
  return rules
}

type RoutingPolicyRecord = {
  id: string
  mode: string
  priorityAccountIds: unknown
  safetyCapPercent: number
  typeRules: unknown
  roundRobinCursor: number
}

function serializeRoutingPolicy(policy: RoutingPolicyRecord) {
  const priorityOrder = normalizeStringList(policy.priorityAccountIds)
  return {
    id: policy.id,
    mode: normalizeMode(policy.mode),
    priorityOrder,
    // Legacy alias for older clients that still read priorityAccountIds.
    priorityAccountIds: priorityOrder,
    safetyCapPercent: Number.isInteger(policy.safetyCapPercent) && policy.safetyCapPercent >= 1 && policy.safetyCapPercent <= 100 ? policy.safetyCapPercent : 85,
    typeRules: normalizeTypeRules(policy.typeRules),
    roundRobinCursor: policy.roundRobinCursor,
  }
}

async function getOrCreateRoutingPolicy(userId: string) {
  return prisma.uploadRoutingPolicy.upsert({
    where: { userId },
    create: { userId, mode: 'auto', priorityAccountIds: [], safetyCapPercent: 85 },
    update: {},
  })
}

/** Drops account ids that are not connected accounts of this user. */
async function filterOwnedConnectedAccountIds(userId: string, accountIds: string[]) {
  if (accountIds.length === 0) return [] as string[]
  const accounts = await prisma.connectedAccount.findMany({ where: { id: { in: accountIds }, userId, status: 'connected' }, select: { id: true } })
  const owned = new Set(accounts.map((account) => account.id))
  return accountIds.filter((id) => owned.has(id))
}

async function updateRoutingPolicy(userId: string, body: z.infer<typeof routingPolicySchema>) {
  const requestedOrder = body.priorityOrder ?? body.priorityAccountIds ?? []
  const priorityOrder = await filterOwnedConnectedAccountIds(userId, [...new Set(requestedOrder)])

  let typeRules: RoutingTypeRules | undefined
  if (body.typeRules !== undefined) {
    const requestedRules = normalizeTypeRules(body.typeRules)
    const ruleAccountIds = await filterOwnedConnectedAccountIds(userId, [...new Set(Object.values(requestedRules))])
    const owned = new Set(ruleAccountIds)
    typeRules = {}
    for (const [kind, accountId] of Object.entries(requestedRules)) {
      if (owned.has(accountId)) typeRules[kind as keyof RoutingTypeRules] = accountId
    }
  }

  const mode = normalizeMode(body.mode)
  return prisma.uploadRoutingPolicy.upsert({
    where: { userId },
    create: {
      userId,
      mode,
      priorityAccountIds: priorityOrder,
      safetyCapPercent: body.safetyCapPercent ?? 85,
      ...(typeRules !== undefined ? { typeRules } : {}),
      roundRobinCursor: 0,
    },
    update: {
      mode,
      priorityAccountIds: priorityOrder,
      ...(body.safetyCapPercent !== undefined ? { safetyCapPercent: body.safetyCapPercent } : {}),
      ...(typeRules !== undefined ? { typeRules } : {}),
      // Round robin was retired by the three-mode engine; reset the cursor so
      // legacy rows do not carry a stale position.
      roundRobinCursor: 0,
    },
  })
}

storageRouter.get('/summary', async (req: AuthRequest, res, next) => {
  try {
    const accounts = await prisma.connectedAccount.findMany({ where: { userId: req.user!.id, status: 'connected' }, include: { storageAccount: true } })
    const summary = accounts.reduce((acc, account) => {
      const storage = account.storageAccount
      acc.totalBytes += storage?.totalBytes ?? 0n
      acc.usedBytes += storage?.usedBytes ?? 0n
      acc.availableBytes += storage?.availableBytes ?? 0n
      return acc
    }, { totalBytes: 0n, usedBytes: 0n, availableBytes: 0n })

    return res.json({
      totalBytes: summary.totalBytes.toString(),
      usedBytes: summary.usedBytes.toString(),
      availableBytes: summary.availableBytes.toString(),
      accounts: accounts.map((account) => ({
        id: account.id,
        provider: account.provider,
        email: account.email,
        status: account.status,
        totalBytes: account.storageAccount?.totalBytes?.toString() ?? null,
        usedBytes: account.storageAccount?.usedBytes.toString() ?? '0',
        availableBytes: account.storageAccount?.availableBytes?.toString() ?? null,
        lastSyncedAt: account.storageAccount?.lastSyncedAt ?? null,
      })),
    })
  } catch (error) {
    return next(error)
  }
})

storageRouter.get('/routing-policy', async (req: AuthRequest, res, next) => {
  try {
    const policy = await getOrCreateRoutingPolicy(req.user!.id)
    return res.json({ policy: serializeRoutingPolicy(policy) })
  } catch (error) {
    return next(error)
  }
})

const handleRoutingPolicyUpdate = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = routingPolicySchema.parse(req.body)
    const policy = await updateRoutingPolicy(req.user!.id, body)
    return res.json({ policy: serializeRoutingPolicy(policy) })
  } catch (error) {
    return next(error)
  }
}

storageRouter.put('/routing-policy', handleRoutingPolicyUpdate)
// Kept as an alias so older clients that PATCH still work.
storageRouter.patch('/routing-policy', handleRoutingPolicyUpdate)

storageRouter.get('/breakdown', async (req: AuthRequest, res, next) => {
  try {
    const rows = await prisma.$queryRaw<BreakdownRow[]>`
      SELECT
        CASE
          WHEN mime_type LIKE 'image/%' THEN 'photo'
          WHEN mime_type LIKE 'video/%' THEN 'video'
          ELSE 'document'
        END AS kind,
        COALESCE(SUM(size_bytes), 0) AS bytes
      FROM files
      WHERE user_id = ${req.user!.id} AND status = 'active'
      GROUP BY kind
    `
    const breakdown = { photo: '0', video: '0', document: '0' }
    for (const row of rows) {
      if (row.kind === 'photo' || row.kind === 'video' || row.kind === 'document') breakdown[row.kind] = bytesToString(row.bytes)
    }
    return res.json(breakdown)
  } catch (error) {
    return next(error)
  }
})
