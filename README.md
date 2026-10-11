# UniDrive

UniDrive is a modern, local-first **cloud storage pooler**. It combines multiple Google Drive accounts (and S3-compatible buckets) into one unified virtual vault: connect your accounts, and UniDrive automatically picks the right drive for every upload, splits oversized files into chunks across accounts, and streams them back with full range seeking — while the server itself stores nothing but a tiny SQLite index.

## License

MIT — see [LICENSE](LICENSE).

## Features

- **Zero server overhead (SQLite WAL)** — the backend keeps only a lightweight SQLite database (WAL mode + busy timeout for safe concurrent chunk writes). Files stream straight through to storage providers; nothing is ever written to server disk.
- **Dynamic chunked uploads (500 MB–1 GB parts)** — files that exceed a single account's free space are split into 500 MB–1 GB sequential parts and dispatched across accounts by free space (most-available, round-robin, or priority routing policies).
- **HTTP 206 range seeking & streaming** — preview and seek inside videos/documents larger than any single drive via `Range` request support across chunk boundaries.
- **Disaster-recovery manifest (`.vault_manifest.json`)** — sealed, per-user encrypted vault manifest synced to storage so the entire file/chunk/account topology can be rebuilt after data loss.
- **Universal Stage viewer** — in-app preview for images, video (Plyr), audio, PDFs, and text.
- **Google Drive + S3-compatible storage** — works with Google Drive, AWS S3, Cloudflare R2, Wasabi, Backblaze B2, MinIO, and any S3-compatible endpoint.
- **Auth** — email/password (Argon2) plus Google sign-in with automatic first-drive connection; JWT access/refresh with hashed refresh tokens and encrypted provider tokens.
- **Storage pools UI** — combined quota tracking, per-account sync, and quota-driven upload routing.
- **Virtual folders, sharing, invites** — nested folders, public share links (hashed tokens), and per-user file/folder invites.
- **External upload API** — API keys with one-time secret display, hashed storage, and last-used tracking (`POST /api/v1/uploads`).
- **Vault manifest page, activity logs, trash, starred & recents** views.

## Quick Start

Requirements: **Node.js 20+**, npm. No MySQL, Docker, or external database needed — SQLite is embedded and auto-created.

```bash
# 1. Install dependencies (root workspace links backend + frontend scripts)
npm install
npm install --prefix backend
npm install --prefix frontend

# 2. Configure the backend
cp backend/.env.example backend/.env
# Edit backend/.env: set JWT_ACCESS_SECRET, TOKEN_ENCRYPTION_KEY, etc.
# (openssl rand -hex 32 generates a valid key)

# 3. Configure the frontend
cp frontend/.env.example frontend/.env

# 4. Initialize the database
cd backend && npm run prisma:migrate && cd ..

# 5. (Optional) Seed your Google OAuth config
cd backend && npm run seed:google-config && cd ..

# 6. Start BOTH servers with one command
npm run dev
```

- Backend API: `http://localhost:45450/api` (health check: `http://localhost:45450/health`)
- Frontend (Vite): `http://localhost:5173`

`npm run dev` uses `concurrently` to run the backend (blue logs) and frontend (magenta logs) in one terminal, and kills both if either fails. You can still run them separately with `npm run dev --prefix backend` and `npm run dev --prefix frontend`.

### Production build

```bash
npm run build   # builds backend (tsc) then frontend (vite build)
npm run start --prefix backend   # run compiled backend from dist/
```


## Google Cloud Setup

1. Create a project at https://console.cloud.google.com and enable the **Google Drive API**.
2. Configure the OAuth consent screen; add your Google account as a test user (or publish the app).
3. Create an **OAuth 2.0 Client ID** (Web application) with redirect URI:
   `http://localhost:45450/api/connected-accounts/google/callback`
4. Put the client ID/secret in `backend/.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) and run:
   ```bash
   cd backend && npm run seed:google-config
   ```
   Alternatively, set the Google OAuth config from the **Settings** page in the UI (stored encrypted in the DB).
5. Sign in with Google from the app — your first Drive account connects automatically.

## Project Structure

```txt
backend/    Express 5 + TypeScript API, Prisma (SQLite), Google Drive/S3 integration
frontend/   React 19 + Vite + Tailwind CSS 4 app
package.json  Root workspace: one-command dev runner (concurrently) + build
```

## API Overview

All routes are prefixed with `/api`. Authenticated routes expect `Authorization: Bearer <accessToken>`.

- **Auth** — `POST /auth/register`, `POST /auth/login`, `POST /auth/google/exchange`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`
- **Storage** — `GET /storage/summary`, `GET /storage/breakdown`
- **Connected accounts** — `GET /connected-accounts`, Google connect/callback flows, `POST /connected-accounts/:id/sync-quota`, `DELETE /connected-accounts/:id`
- **Folders** — `GET /folders`, `POST /folders`, `PATCH /folders/:id`, `DELETE /folders/:id`, `GET /folders/recent`
- **Files** — `GET /files`, `PATCH /files/:id`, `POST /files/:id/share`, `GET /files/:id/download`, `GET /files/preview/:token`, `POST /files/sync-google`, batch move/delete
- **Uploads** — `POST /uploads` (multipart; metadata-first `filesMeta` protocol, resumable sessions)
- **Vault** — manifest seal/sync/restore endpoints (`.vault_manifest.json`)
- **External API** — `POST /api/v1/uploads` via API keys
- **Public shares** — `GET /public/files/:token`, `/download`, `/preview`

## Security Notes

- Never commit `.env` files or secrets (root and backend `.gitignore` cover `.env*`, `*.pem`, `*.key`, and SQLite `*.db` files).
- Google tokens are encrypted at rest; app refresh tokens are hashed; share/preview/public tokens are stored as hashes.
- Uploaded files stream through the backend to storage and are never written to server disk.
- CORS is restricted to `FRONTEND_URL`.

## Attribution / Credits

UniDrive was initially inspired by and refactored from early **9drive** concepts into a local-first, chunk-pooled storage architecture.
