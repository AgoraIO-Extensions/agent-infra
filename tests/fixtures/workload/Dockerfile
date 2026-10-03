FROM node@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03
ARG VERSION=A
ENV VERSION=$VERSION
LABEL io.agora.agent.runtime.manifest='{"schemaVersion":1,"interactionMode":"self-managed","service":{"port":8080},"health":{"path":"/healthz"}}'
COPY server.mjs /fixture/server.mjs
USER 1000:1000
CMD ["node", "/fixture/server.mjs"]
