import { createServer, type RequestListener, type Server } from "node:http";
import { KubeConfig } from "@kubernetes/client-node";
import { afterEach, expect, it } from "vitest";
import { createOperationsKubernetesReaderV2 } from "./operations-kubernetes.js";

const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections();
					server.close(() => resolve());
				}),
		),
	);
});
async function reader(handler: RequestListener) {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error();
	const kubeConfig = new KubeConfig();
	kubeConfig.loadFromOptions({
		clusters: [
			{
				name: "fixture",
				server: `http://127.0.0.1:${address.port}`,
				skipTLSVerify: true,
			},
		],
		users: [{ name: "fixture" }],
		contexts: [{ name: "fixture", cluster: "fixture", user: "fixture" }],
		currentContext: "fixture",
	});
	return createOperationsKubernetesReaderV2({
		namespace: "approved",
		cacheOwner: "approved-cache",
		readCluster: false,
		kubeConfig,
	});
}

it("uses only approved GET endpoints and denies cluster reads before sending", async () => {
	const requests: string[] = [];
	const read = await reader((request, response) => {
		requests.push(`${request.method} ${request.url}`);
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(
			JSON.stringify({ items: [], metadata: { continue: "next-page" } }),
		);
	});
	await expect(read("pods", AbortSignal.timeout(2000))).resolves.toEqual({
		items: [],
		truncated: true,
	});
	await expect(read("nodes", AbortSignal.timeout(2000))).rejects.toThrow(
		"Operations scope unavailable",
	);
	expect(requests).toEqual(["GET /api/v1/namespaces/approved/pods?limit=2000"]);
});

it("cancels an in-flight read and rejects an oversized body without exposing it", async () => {
	let started: (() => void) | undefined;
	const observed = new Promise<void>((resolve) => {
		started = resolve;
	});
	const read = await reader((_request, response) => {
		started?.();
		response.writeHead(200, { "Content-Type": "application/json" });
		response.write('{"items":[');
	});
	const controller = new AbortController();
	const pending = read("pods", controller.signal);
	const rejection = expect(pending).rejects.toThrow(
		"Operations Kubernetes query unavailable",
	);
	await observed;
	controller.abort();
	await rejection;
	const oversized = await reader((_request, response) => {
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end("x".repeat(8 * 1024 * 1024 + 1));
	});
	await expect(oversized("pods", AbortSignal.timeout(2000))).rejects.toThrow(
		"Operations Kubernetes query unavailable",
	);
});
