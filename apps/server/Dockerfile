# SERIES TS 后端镜像（pi 重构版）。
# 构建：docker build -t series-ts:local -f apps/server/Dockerfile .
# 前端静态产物由 compose 或部署脚本拷入 /app/web-dist 后由 Fastify 静态托管（M8 接线）。

FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/pnpm-lock.yaml* ./apps/server/
RUN pnpm install --frozen-lockfile=false --filter @series/server... || pnpm install --filter @series/server...
COPY apps/server ./apps/server
COPY web/package.json web/package-lock.json* ./web/
RUN cd web && npm install --no-audit --no-fund
COPY web ./web
RUN cd web && npm run build:static
RUN cd apps/server && pnpm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# 常用工具：worker 的 bash 工具会用到
RUN apk add --no-cache curl ripgrep vim jq nmap bash
COPY --from=build /repo/apps/server/dist ./dist
COPY --from=build /repo/apps/server/node_modules ./node_modules
COPY --from=build /repo/apps/server/package.json ./package.json
COPY --from=build /repo/web/out ./web-dist
ENV SERIES_STATIC_DIR=/app/web-dist
EXPOSE 8787 8788
CMD ["node", "dist/index.js", "-addr", ":8787", "-proxy", "0.0.0.0:8788", "-data", "/app/data"]
