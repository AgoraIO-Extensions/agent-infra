FROM node@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

ARG SAMPLE_VERSION=sample-a
ENV CUSTOM_AGENT_VERSION=$SAMPLE_VERSION
LABEL io.agora.agent.runtime.manifest='{"schemaVersion":1,"interactionMode":"self-managed","service":{"port":8080},"health":{"path":"/healthz"}}'

COPY --chown=node:node server.mjs /app/server.mjs
USER node
EXPOSE 8080
ENTRYPOINT ["node", "/app/server.mjs"]
