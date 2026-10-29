ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG APP_VERSION=invoice-v1
ENV APP_VERSION=${APP_VERSION}
ENV DATA_DIR=/workspace/invoices
LABEL io.agora.agent.runtime.manifest='{"schemaVersion":1,"interactionMode":"self-managed","service":{"port":8080},"health":{"path":"/healthz"}}'

COPY --chown=1000:1000 server.ts /app/invoice-server.ts
USER 1000:1000
WORKDIR /app
EXPOSE 8080
ENTRYPOINT ["node", "--experimental-strip-types", "/app/invoice-server.ts"]
