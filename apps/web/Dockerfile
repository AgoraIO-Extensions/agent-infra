FROM node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS builder
RUN npm install -g pnpm@11.20.0
WORKDIR /app
ARG VITE_PLATFORM_LOGIN_URL
ARG VITE_PLATFORM_LOGOUT_URL
ENV VITE_PLATFORM_LOGIN_URL=$VITE_PLATFORM_LOGIN_URL
ENV VITE_PLATFORM_LOGOUT_URL=$VITE_PLATFORM_LOGOUT_URL

COPY . .
RUN pnpm install --frozen-lockfile --store-dir /pnpm-store

ENV NODE_ENV=production
RUN pnpm --filter @agent-infra/web... build

FROM nginx:1.31.6-alpine3.24@sha256:d10753d9289b8e3f884386351f73554ce72b631378949deddd75e83ee296c427 AS runner
RUN apk add --no-cache libexpat=2.8.5-r0 libuuid=2.42.3-r1 pcre2=10.49-r0 \
    libpng=1.6.59-r0 nghttp2-libs=1.70.0-r0 \
    && rm -f /var/log/apk.log
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx-main.conf /etc/nginx/nginx.conf
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
USER nginx
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
