# Multi-stage build: compile TypeScript + generate the Prisma client in a
# full node image, then ship only production deps + compiled output in a
# slim runtime image. No dev dependencies (tsx, vitest, typescript itself)
# in the final image.

FROM node:22-alpine AS builder
WORKDIR /app
# Alpine ships no OpenSSL runtime library by default. Without it, `prisma
# generate` can't detect a real OpenSSL version to target and silently
# defaults to guessing one — the query engine binary it produces may not
# match what's actually available, which fails at runtime, not build
# time (this bit us in exactly that way: build succeeded, container
# crashed on first request). Installing it here, before `generate` runs,
# is what makes the detection — and the binary it picks — correct.
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx prisma generate --schema=src/db/prisma/schema.prisma
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache openssl
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Prisma's generated client is a native-ish artifact keyed to the schema —
# copy it rather than regenerating, so the runtime image doesn't need the
# Prisma CLI (a dev dependency) at all.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/dist ./dist
# Migration SQL files, needed for `prisma migrate deploy` to run from this
# same image (see docs/DEPLOYMENT.md) — not needed at runtime by the server
# itself, but keeping them in one image avoids a second build just for migrations.
COPY --from=builder /app/src/db/prisma ./src/db/prisma

EXPOSE 4000
CMD ["node", "dist/server.js"]
