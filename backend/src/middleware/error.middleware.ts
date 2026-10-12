import type { NextFunction, Request, Response } from 'express'
import { env } from '../config/env.js'

export function errorMiddleware(error: unknown, _req: Request, res: Response, next: NextFunction) {
  // Responses that already started (broken stream) must delegate back to Express
  // instead of attempting to write headers a second time.
  if (res.headersSent) return next(error)

  const status = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : 500
  const message = error instanceof Error ? error.message : 'Internal server error'

  // Explicitly (re)apply CORS headers before the error body: without them the
  // browser discards the response and surfaces a bare
  // "NetworkError when attempting to fetch resource." instead of the real cause.
  res.header('Access-Control-Allow-Origin', env.FRONTEND_URL || 'http://localhost:5173')
  res.header('Access-Control-Allow-Credentials', 'true')

  return res.status(status).json({ success: false, code: 'INTERNAL_SERVER_ERROR', message })
}
