FROM node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS builder
RUN npm install -g pnpm@11.20.0
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile --store-dir /pnpm-store

ENV NODE_ENV=production
RUN pnpm --filter @agent-infra/web build

FROM nginx:1.31.5-alpine3.24@sha256:a9ae6f6d078d477e21323310498e5196cb2b7c0aedd9e07b7306612077227d7c AS runner
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx-main.conf /etc/nginx/nginx.conf
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
USER nginx
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
