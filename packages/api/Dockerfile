# ── Builder ──
FROM node:24-alpine AS builder

ARG HTTP_PROXY HTTPS_PROXY NO_PROXY
ENV HTTP_PROXY=${HTTP_PROXY} HTTPS_PROXY=${HTTPS_PROXY} NO_PROXY=${NO_PROXY}
ENV NODE_TLS_REJECT_UNAUTHORIZED=0

WORKDIR /app
RUN npm config set strict-ssl false
COPY package*.json ./
RUN npm ci --fetch-timeout=120000
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

# ── Production ──
FROM node:24-alpine

WORKDIR /app
COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# devDependencies 제거 (typescript 등)
RUN npm prune --omit=dev 2>/dev/null; true

RUN addgroup -g 1001 nodejs && adduser -u 1001 -G nodejs -s /bin/sh -D nodejs
USER nodejs

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node --input-type=commonjs -e "const h=require('http');h.get('http://localhost:3000/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
