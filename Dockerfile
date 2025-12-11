FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./tsconfig.json
COPY prisma ./prisma
RUN npm ci
RUN npx prisma generate

COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-slim

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

EXPOSE 8080

CMD ["node", "dist/ingest/server.js"]
