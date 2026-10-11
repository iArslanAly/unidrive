import dotenv from 'dotenv'
import { z } from 'zod'

dotenv.config()

const envSchema = z.object({
  DATABASE_URL: z.string().min(1).default('file:./dev.db'),
  /** Local dev port; accepts "45450" or 45450. */
  PORT: z.coerce.number().default(45450),
  /** Container port override (docker-compose sets 4000); wins over PORT when present. */
  APP_PORT: z.coerce.number().optional(),
  FRONTEND_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(32),
  TOKEN_ENCRYPTION_KEY: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  MAX_UPLOAD_BYTES: z.coerce.number().default(5 * 1024 * 1024 * 1024),
})

export const env = envSchema.parse(process.env)
