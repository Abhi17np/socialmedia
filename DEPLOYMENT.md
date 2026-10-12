# Deployment Runbook

What exists today: a `backend/Dockerfile`, a `frontend/Dockerfile`, and a root `docker-compose.yml` for local/self-hosted orchestration. What does **not** exist: a CI deploy step, a hosting-provider config, or a production Supabase project — those are deliberate choices for you to make, not something to fabricate here. This document is the "how to actually run it" piece the codebase was missing; it doesn't pick a host for you.

## What's containerized vs. what isn't

- **Backend** (`backend/Dockerfile`): a plain long-running Node process — the BullMQ worker and interval-based pollers/scheduler run in-process (`social/queue.js`, `social/scheduler.js`, `social/pollers.js`), not as separate workers. One container, one process. Needs `REDIS_URL` and a real Supabase project reachable at runtime.
- **Frontend** (`frontend/Dockerfile`): Next.js's standalone build output. `NEXT_PUBLIC_API_BASE` is a **build arg**, not just a runtime env var — Next.js inlines `NEXT_PUBLIC_*` values into the client bundle at build time, so the image has to be built with the real, externally-reachable backend URL already known.
- **Redis**: containerized via `docker-compose.yml` for local/self-hosted use. A managed Redis (Upstash, ElastiCache, etc.) is the better call for anything beyond a single box — just point `REDIS_URL` at it instead.
- **Supabase (Postgres)**: never containerized here — it's Supabase's own managed service. Run `backend/migrations/*.sql` against it, in order, before the backend starts (see the root README's Getting Started section; there's still no automated migration runner — these are applied by hand).

## Local / self-hosted: `docker compose up`

```bash
cp backend/.env.example backend/.env   # fill in SUPABASE_URL_SOCIAL, SUPABASE_KEY_SOCIAL, JWT_SECRET, etc.
docker compose up --build
```

Backend on `:5001`, frontend on `:3000`, Redis internal-only. The frontend image is built with `NEXT_PUBLIC_API_BASE` defaulting to `http://localhost:5001/api/v1` — override it (`NEXT_PUBLIC_API_BASE=https://api.yourdomain.com/api/v1 docker compose up --build`) if the backend won't be reachable at localhost from wherever the browser runs.

## A real deployment (your call to make)

This repo gives you the images; where they run is a decision with real cost/ops tradeoffs this document won't make for you. Three realistic shapes:

1. **A single VM/box** (cheapest, most hands-on): install Docker, `git clone`, `docker compose up -d`, put a reverse proxy (Caddy or nginx) in front for TLS. Restart policy (`unless-stopped`) is already in `docker-compose.yml`; you own patching the host.
2. **A container platform** (Railway, Render, Fly.io, Google Cloud Run, AWS App Runner): point each at its own `Dockerfile` (backend and frontend as two separate services, not the compose file — these platforms build and run one container per service). Point `REDIS_URL` at a managed Redis add-on rather than running Redis as a third service, since these platforms don't have a good story for a container with a persistent volume.
3. **Kubernetes**: not provided here — no manifests exist in this repo. If you need this, treat the two Dockerfiles as the starting point for a Deployment + Service per component, Redis as a StatefulSet or managed external service, and the backend's graceful-shutdown handling (`server.js`'s SIGTERM/SIGINT handling) as already compatible with a rolling-update eviction.

Whichever you pick, the backend needs every required env var from `backend/.env.example` set in that platform's own secrets/env config — never baked into the image (the `.dockerignore` already excludes `.env`).

## Health checks

`GET /api/v1/health` returns `{"status":"ok"}` unauthenticated — point any platform's health-check config at that, not `/`.

## Zero-downtime restarts

The backend's shutdown handling (`server.js`) closes the HTTP server, stops the BullMQ worker and both pollers, and releases the port before exiting — it does not exit immediately like it used to. An orchestrator that sends `SIGTERM` and waits before hard-killing (every one of the platforms above does this) gets a clean stop; one that sends `SIGKILL` immediately does not give it the chance to.

## Build-time requirement: outbound internet for the frontend image

`app/layout.jsx` uses `next/font/google` (self-hosts Inter, but still fetches it from Google Fonts at **build** time, not runtime). `docker build ./frontend` needs outbound internet access during the build step — this surfaced when verifying the Dockerfile in a network-sandboxed environment and is worth knowing if your CI/build runner has restricted egress. Any normal cloud build environment (GitHub Actions, Railway, Render, Vercel, a VM with normal internet) has this by default; an air-gapped or heavily firewalled builder would need either temporary egress to fonts.googleapis.com or a switch to `next/font/local` with the font file checked into the repo.

## What this runbook does not cover

- Zero-downtime blue/green or canary deploys — not built, not a config toggle away.
- Database migration automation — still "run the `.sql` files by hand, in order."
- Secrets rotation, backups, monitoring/alerting, log aggregation beyond pino's structured JSON output.

These are real gaps for a production SaaS, not oversights to pretend don't exist. Build them when they're actually needed, not speculatively here.
