FROM node@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

LABEL io.agora.agent.runtime.manifest='{"schemaVersion":1,"interactionMode":"platform-adapter","protocol":"acp","service":{"port":3003},"health":{"path":"/healthz"},"capabilities":{"modelSelection":true}}'

EXPOSE 3003
COPY peer.mjs /fixture/peer.mjs
USER 1000:1000
CMD ["node", "/fixture/peer.mjs"]
