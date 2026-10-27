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
const requestOnce = (value: string) => new Promise<number | undefined>((resolve, reject) => {
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

const connectionErrors = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENOTFOUND",
]);
const request = async (value: string) => {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      return await requestOnce(value);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
      if (typeof code !== "string" || !connectionErrors.has(code) || Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
    }
  }
};

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
