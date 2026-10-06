import { createHash } from "node:crypto";

export const imageDockerfiles = {
  web: "apps/web/Dockerfile",
  "platform-api": "apps/platform-api/Dockerfile",
  "platform-worker": "apps/platform-worker/Dockerfile",
  "enterprise-directory-sync": "apps/enterprise-directory-sync/Dockerfile",
  "connection-api": "apps/connection-api/Dockerfile",
  "agent-runtime-host": "apps/agent-runtime-host/Dockerfile",
  "custom-agent-base": "deploy/images/custom-agent-base/Dockerfile",
};

export const imageNames = Object.keys(imageDockerfiles);
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
