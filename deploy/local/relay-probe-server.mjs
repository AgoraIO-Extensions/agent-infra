import { readFileSync } from "node:fs";
import { createServer } from "node:https";

const endpoint = process.env.RELAY_PROBE_ENDPOINT;
const redirectUrl = process.env.RELAY_PROBE_REDIRECT_URL;
if ((endpoint !== "a" && endpoint !== "b") || !redirectUrl) {
	throw new Error("relay probe endpoint is not configured");
}

let requests = 0;
let authorizationPresent = 0;
let redirects = 0;

const server = createServer(
	{
		key: readFileSync("/tls/tls.key"),
		cert: readFileSync("/tls/tls.crt"),
	},
	(request, response) => {
		const url = new URL(request.url ?? "/", "https://relay-probe.invalid");
		const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
			request.socket.remoteAddress ?? "",
		);
		if (url.pathname === "/__probe/health") {
			response.writeHead(200).end();
			return;
		}
		if (url.pathname.startsWith("/__probe/")) {
			if (!local) {
				response.writeHead(403).end();
				return;
			}
			if (url.pathname === "/__probe/reset" && request.method === "POST") {
				requests = 0;
				authorizationPresent = 0;
				redirects = 0;
				response.writeHead(204).end();
				return;
			}
			if (url.pathname === "/__probe/receipt" && request.method === "GET") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(
					JSON.stringify({ endpoint, requests, authorizationPresent, redirects }),
				);
				return;
			}
			response.writeHead(404).end();
			return;
		}

		request.resume();
		requests += 1;
		if (request.headers.authorization) authorizationPresent += 1;
		if (endpoint === "a" && url.searchParams.get("redirect") === "b") {
			redirects += 1;
			response.writeHead(307, {
				location: redirectUrl,
				"cache-control": "no-store",
				"content-length": "0",
			});
			response.end();
			return;
		}
		response.writeHead(200, {
			"content-type": "application/json",
			"cache-control": "no-store",
		});
		response.end(JSON.stringify({ synthetic: true, endpoint }));
	},
);

server.listen(8443, "0.0.0.0");
process.once("SIGTERM", () => server.close());
