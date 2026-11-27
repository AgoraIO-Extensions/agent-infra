import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createPlatformHealthApp } from "../app.js";
import { registerMaintenanceTerminalAccess } from "./maintenance-terminal-access.js";

it("routes only the signed-in creator and closes both sockets on revocation", async () => {
	const worker = createServer();
	const peers = new WebSocketServer({ server: worker });
	const paths: string[] = [];
	peers.on("connection", (ws, req) => {
		paths.push(req.url ?? "");
		ws.on("message", (data, binary) => ws.send(data, { binary }));
		ws.send("ready");
	});
	worker.listen(0, "127.0.0.1");
	await once(worker, "listening");
	const origin = "https://web.example.test";
	const directory = "df373309-d478-44aa-9139-a978319cfaaa";
	let owner = true;
	const app = createPlatformHealthApp();
	registerMaintenanceTerminalAccess(app, {
		identity: {
			resolve: async (request) => {
				const id = request.headers.get("cookie")?.slice(5);
				return id
					? {
							schemaVersion: 1,
							userId: id,
							displayName: id,
							accountStatus: "active",
							roles: ["employee"],
							organizationIds: [],
							authorizationRevision: "fixture",
						}
					: null;
			},
			hydrateUsers: async () => [],
		},
		readAccess: async ({ actorId, agentId }) =>
			owner && actorId === "alice" && agentId === "first",
		readDirectory: async ({ actorId, agentId }) =>
			owner && actorId === "alice" && agentId === "first" ? directory : null,
		transport: {
			publicOrigin: origin,
			connect: (id) =>
				new WebSocket(
					`ws://127.0.0.1:${(worker.address() as AddressInfo).port}/${id}`,
				),
		},
	});
	const api = serve({
		fetch: app.fetch,
		port: 0,
		hostname: "127.0.0.1",
		websocket: {
			server: new WebSocketServer({ noServer: true, maxPayload: 32768 }),
		},
	});
	await once(api, "listening");
	const open = (id: string, agent = "first", from = origin) =>
		new WebSocket(
			`ws://127.0.0.1:${(api.address() as AddressInfo).port}/api/v2/agents/${agent}/maintenance-terminal/socket`,
			{ headers: { origin: from, cookie: `user=${id}` } },
		);
	const refused = async (ws: WebSocket) => {
		const [response] = await once(ws, "unexpected-response").then((args) => [
			args[1],
		]);
		response.resume();
		ws.on("error", () => {});
		ws.terminate();
		return response.statusCode;
	};
	try {
		expect(await refused(open("bob"))).toBe(403);
		expect(await refused(open("alice", "other"))).toBe(403);
		expect(
			await refused(open("alice", "first", "https://unrelated.example.test")),
		).toBe(403);
		expect(paths).toEqual([]);
		const ws = open("alice");
		expect((await once(ws, "message"))[0].toString()).toBe("ready");
		const echo = once(ws, "message");
		ws.send(Buffer.from("abc\u0003"));
		expect((await echo)[0].toString()).toBe("abc\u0003");
		expect(paths).toEqual([`/${directory}`]);
		const closed = once(ws, "close");
		const disconnected = Promise.all(
			[...peers.clients].map((s) => once(s, "close")),
		);
		owner = false;
		expect((await closed)[0]).toBe(1008);
		await disconnected;
		expect(await refused(open("alice"))).toBe(403);
	} finally {
		for (const ws of peers.clients) ws.terminate();
		peers.close();
		api.close();
		worker.close();
	}
});
