import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";

const [tokenFile, apiPortText, webPortText] = process.argv.slice(2);
const apiPort = Number(apiPortText);
const webPort = Number(webPortText);
if (
  !tokenFile?.startsWith("/") ||
  ![apiPort, webPort].every((port) => Number.isInteger(port) && port > 0 && port <= 65535)
) {
  throw new Error("Local API auth probe configuration is invalid");
}

const token = (await readFile(tokenFile, "utf8")).trim();
const request = (value) => new Promise((resolve, reject) => {
  const probe = httpRequest({
    hostname: "127.0.0.1",
    port: apiPort,
    path: "/auth/login",
    method: "HEAD",
    signal: AbortSignal.timeout(5000),
    headers: {
      host: `localhost:${webPort}`,
      "x-forwarded-proto": "https",
      "x-platform-proxy-token": value,
    },
  }, (response) => {
    response.resume();
    response.once("end", () => resolve(response.statusCode));
    response.once("error", reject);
  });
  probe.once("error", reject);
  probe.end();
});

try {
  if (
    (await request(token)) !== 405 ||
    (await request(randomBytes(32).toString("base64url"))) !== 400
  ) {
    throw new Error();
  }
} catch {
  throw new Error("Local API login proxy-token boundary is unavailable");
}
