FROM node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81
RUN apk add --no-cache --upgrade 'libcrypto3=3.5.8-r0' 'libssl3=3.5.8-r0' \
    && npm install --global npm@11.19.1 --logs-max=0 \
    && rm -rf /root/.npm /tmp/node-compile-cache /var/log/apk.log \
    && mkdir /workspace \
    && chown node:node /workspace
WORKDIR /workspace
USER node
CMD ["node", "--version"]
