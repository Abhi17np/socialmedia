# Multi-stage build using Next.js's standalone output (next.config.js's
# output: 'standalone') — the final image only carries the server bundle
# and the production dependencies it actually traced, not the full
# node_modules tree or the build toolchain.
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* vars are inlined into the client bundle at build time —
# pass the real backend URL as a build arg, not just a runtime env var,
# or the deployed frontend will call whatever was baked in here (default:
# the same localhost fallback apiBase.js uses in dev).
ARG NEXT_PUBLIC_API_BASE=http://localhost:5001/api/v1
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

USER node
EXPOSE 3000
CMD ["node", "server.js"]
