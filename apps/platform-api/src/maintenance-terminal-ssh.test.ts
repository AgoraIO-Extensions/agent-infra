import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import ssh2 from "ssh2";
import { expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { maintenanceSshEndpoint } from "./maintenance-terminal-ssh.js";

it("redeems a creator's login once and resizes the same Worker PTY over SSH", async () => {
	const worker = createServer();
	const wss = new WebSocketServer({ server: worker });
	worker.listen(0, "127.0.0.1");
	await once(worker, "listening");
	const sizes: unknown[] = [];
	wss.on("connection", (ws) => {
		ws.on("message", (data, binary) => {
			if (binary) ws.send(data);
			else sizes.push(JSON.parse(data.toString()));
		});
		ws.send("ready");
	});
	const scope = { agentId: "sample", actorId: "creator" };
	let stored = "";
	let allowed = true;
	const ssh = maintenanceSshEndpoint(
		{
			host: "localhost",
			publicPort: 2222,
			listenPort: 0,
			hostKey: Buffer.from(ssh2.utils.generateKeyPairSync("ed25519").private),
		},
		{
			issue: async (v) => {
				stored = v.tokenDigest;
			},
			redeem: async (digest) => {
				if (stored !== digest) return null;
				stored = "";
				return scope;
			},
			current: async () => (allowed ? "directory" : null),
		},
		{
			publicOrigin: "https://example.test",
			connect: () =>
				new WebSocket(
					`ws://127.0.0.1:${(worker.address() as AddressInfo).port}`,
				),
		},
	);
	const listener = ssh.start("127.0.0.1");
	await once(listener.server, "listening");
	const login = await ssh.issue(scope);
	const dial = () => {
		const client = new ssh2.Client();
		client.connect({
			host: "127.0.0.1",
			port: (listener.server.address() as AddressInfo).port,
			username: "maintenance",
			password: login.password,
			hostVerifier: (key: Buffer) =>
				`SHA256:${requireHash(key)}` === login.fingerprint,
			readyTimeout: 3000,
		});
		return client;
	};
	const { createHash } = await import("node:crypto");
	function requireHash(data: Buffer) {
		return createHash("sha256")
			.update(data)
			.digest("base64")
			.replace(/=+$/, "");
	}
	const client = dial();
	try {
		await once(client, "ready");
		const channel = await new Promise<ssh2.ClientChannel>((ok, no) =>
			client.shell({ term: "xterm", cols: 90, rows: 28 }, (error, stream) =>
				error ? no(error) : ok(stream),
			),
		);
		await expect.poll(() => sizes).toContainEqual({ cols: 90, rows: 28 });
		const received = once(channel, "data");
		channel.write("test");
		expect((await received)[0].toString()).toBe("test");
		channel.setWindow(32, 100, 0, 0);
		await expect.poll(() => sizes).toContainEqual({ cols: 100, rows: 32 });
		await expect(once(dial(), "ready")).rejects.toThrow();
		const disconnected = once(client, "close");
		allowed = false;
		await disconnected;
	} finally {
		client.end();
		listener.close();
		wss.close();
		worker.close();
	}
});
