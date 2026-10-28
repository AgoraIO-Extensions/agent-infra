import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";

/** Process-local HTTPS fixture, no host trust/DNS changes or upstream network. */
export async function nativeNetworkFixture() {
	const root = await mkdtemp(join(tmpdir(), "native-network-"));
	const cert = join(root, "fixture.pem");
	const key = join(root, "fixture-key.pem");
	await promisify(execFile)("openssl", [
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-keyout",
		key,
		"-out",
		cert,
		"-days",
		"1",
		"-subj",
		"/CN=content.fixture.invalid",
		"-addext",
		"subjectAltName=DNS:content.fixture.invalid,DNS:api.anthropic.com,DNS:mcp.exa.ai",
	]);
	const observed: {
		host: string | undefined;
		domainCheck: boolean;
		credential: boolean;
	}[] = [];
	const sockets = new Set<Duplex>();
	const origin = createHttpsServer(
		{ cert: await readFile(cert), key: await readFile(key) },
		(request, response) => {
			const domainCheck =
				request.headers.host === "api.anthropic.com" &&
				request.url === "/api/web/domain_info?domain=content.fixture.invalid";
			observed.push({
				host: request.headers.host,
				domainCheck,
				credential:
					request.headers.authorization !== undefined ||
					request.headers["x-api-key"] !== undefined,
			});
			if (
				request.headers.host === "mcp.exa.ai" &&
				request.url === "/mcp" &&
				request.method === "POST"
			) {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						result: {
							content: [
								{ type: "text", text: "Synthetic anonymous Exa search result" },
							],
						},
					}),
				);
				return;
			}
			if (domainCheck) {
				response.writeHead(200, { "content-type": "application/json" });
				response.end('{"can_fetch":true}');
				return;
			}
			if (
				request.headers.host === "content.fixture.invalid" &&
				request.url === "/content"
			) {
				response.writeHead(200, { "content-type": "text/html" });
				response.end(
					"<html><body>Synthetic native fetch content.</body></html>",
				);
				return;
			}
			response.writeHead(403);
			response.end();
		},
	);
	await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
	const originAddress = origin.address();
	if (!originAddress || typeof originAddress === "string") throw Error();
	const proxy = createServer((_request, response) => {
		response.writeHead(403);
		response.end();
	});
	proxy.on("connect", (request, socket, head) => {
		if (
			![
				"api.anthropic.com:443",
				"content.fixture.invalid:443",
				"mcp.exa.ai:443",
			].includes(request.url ?? "")
		) {
			socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
			return;
		}
		const upstream = connect(originAddress.port, "127.0.0.1", () => {
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length) upstream.write(head);
			socket.pipe(upstream);
			upstream.pipe(socket);
		});
		sockets.add(upstream);
		sockets.add(socket);
		upstream.on("error", () => socket.destroy());
		socket.on("error", () => upstream.destroy());
		socket.on("close", () => {
			upstream.destroy();
			sockets.delete(socket);
			sockets.delete(upstream);
		});
	});
	await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
	const address = proxy.address();
	if (!address || typeof address === "string") throw Error();
	return {
		url: "https://content.fixture.invalid/content",
		observed,
		env: {
			HTTPS_PROXY: `http://127.0.0.1:${address.port}`,
			HTTP_PROXY: `http://127.0.0.1:${address.port}`,
			NO_PROXY: "127.0.0.1,localhost",
			NODE_EXTRA_CA_CERTS: cert,
		},
		async close() {
			for (const socket of sockets) socket.destroy();
			proxy.closeAllConnections();
			origin.closeAllConnections();
			await Promise.all([
				new Promise<void>((resolve) => proxy.close(() => resolve())),
				new Promise<void>((resolve) => origin.close(() => resolve())),
			]);
			await rm(root, { recursive: true, force: true });
		},
	};
}
