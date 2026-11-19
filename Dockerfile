# syntax=docker/dockerfile:1

# Etapa 1: compila o portal Angular.
FROM node:24-alpine AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
# Regras compartilhadas entre portal e servidor (nota da documentação).
COPY shared/ ../shared/
RUN npm run build
# The same OpenAPI → catalog conversion, for the server's initial import (CATALOG_IMPORT).
RUN npm run build:importer

# Etapa 2: só as dependências de produção do servidor.
FROM node:24-alpine AS server-deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# Etapa final: servidor Node + portal já compilado.
FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_FILE=/data/apis.json
WORKDIR /app

COPY --from=server-deps /app/server/node_modules ./server/node_modules
COPY server/package.json ./server/
COPY server/src ./server/src
COPY --from=web-build /app/server/generated ./server/generated
COPY shared ./shared
COPY server/data/seed.json ./server/data/seed.json
COPY --from=web-build /app/web/dist/web/browser ./web/dist/web/browser

# As APIs cadastradas ficam no volume /data, fora da imagem.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
