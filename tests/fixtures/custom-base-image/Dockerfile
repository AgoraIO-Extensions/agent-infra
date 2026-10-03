ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY --chown=node:node probe.mjs /example/probe.mjs
RUN node --check /example/probe.mjs
CMD ["node", "/example/probe.mjs"]
