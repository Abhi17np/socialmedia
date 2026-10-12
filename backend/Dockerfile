# Production image for the backend only — a plain long-running Node
# process (BullMQ worker + interval-based pollers/scheduler all run
# in-process, see social/queue.js, social/scheduler.js, social/pollers.js),
# not a serverless function. Needs Redis reachable (REDIS_URL) and a
# real Supabase project (SUPABASE_URL_SOCIAL/SUPABASE_KEY_SOCIAL) at
# runtime — neither is baked into this image.
FROM node:22-alpine AS base
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Runs as a non-root user — the "node" user/group ships in the official
# image already; no need to create one.
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 5001

# server.js reads PORT from the environment (defaults to 5001 — see
# .env.example) and handles SIGTERM/SIGINT gracefully (closes the HTTP
# server, stops the BullMQ worker and pollers, releases the port) rather
# than exiting immediately — see server.js's shutdown() for why that
# matters under an orchestrator that sends SIGTERM on every redeploy.
CMD ["node", "server.js"]
