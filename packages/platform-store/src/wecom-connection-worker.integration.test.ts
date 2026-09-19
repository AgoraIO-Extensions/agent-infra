import { once } from "node:events";
import type { WecomMessageV1 } from "@agent-infra/platform-core";
import postgres from "postgres";
import { expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { createPlatformWecomConnectionsV1 } from "../../../apps/platform-worker/src/wecom-connections.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import { startPostgresTestDatabase } from "./postgres-test.ts";

it("keeps one live owner, replies to denied ingress and fences old reply routes after takeover", async () => {
	const db = await startPostgresTestDatabase("wecom-owner-worker");
	const sql = postgres(db.databaseUrl);
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No address");
	let socket: WebSocket | undefined;
	let auths = 0;
	let replies = 0;
	server.on("connection", (current) => {
		socket = current;
		current.on("message", (raw) => {
			const frame = JSON.parse(raw.toString());
			if (frame.cmd === "aibot_subscribe") auths++;
			else if (frame.cmd === "aibot_respond_msg") replies++;
			current.send(JSON.stringify({ headers: frame.headers, errcode: 0 }));
		});
	});
	const received: WecomMessageV1[] = [];
	const states: string[] = [];
	const options = {
		...db,
		endpoint: `ws://127.0.0.1:${address.port}`,
		bindings: async () => [
			{
				agentId: "agent",
				bindingReference: "binding",
				credentialVersion: "v1",
				botId: "bot",
				secret: "fixture",
			},
		],
		protectReply: async (route: unknown) => JSON.stringify(route),
		revealReply: async (handle: string) => JSON.parse(handle),
		observeConnection: (status: string) => states.push(status),
		receive: async (message: WecomMessageV1) => {
			received.push(message);
			return { outcome: "denied" as const };
		},
	};
	const first = createPlatformWecomConnectionsV1({
		...options,
		holderId: "one",
	});
	const second = createPlatformWecomConnectionsV1({
		...options,
		holderId: "two",
	});
	try {
		await migratePlatformDatabase(db);
		await sql`insert into platform.agents (id,current_configuration_revision,authorization_revision) values ('agent',1,'revision')`;
		await sql`insert into platform.agent_configuration_revisions (agent_id,revision,source_reference,created_at,configuration) values ('agent',1,'fixture',now(),${sql.json({ schemaVersion: 2, agentId: "agent", revision: 1, channels: [{ kind: "wecom_bot", bindingReference: "binding" }] })})`;
		await first.tick();
		await expect.poll(() => states).toContain("connected");
		await second.tick();
		expect(auths).toBe(1);
		socket?.send(
			JSON.stringify({
				cmd: "aibot_msg_callback",
				headers: { req_id: "request" },
				body: {
					aibotid: "bot",
					msgid: "event",
					chattype: "group",
					chatid: "group",
					from: { userid: "sender" },
					msgtype: "text",
					text: { content: "fixture" },
				},
			}),
		);
		await expect.poll(() => replies).toBe(1);
		expect(received).toHaveLength(1);
		const message = received[0];
		if (!message) throw new Error("No message");
		expect(
			await second.sender.send({
				scope: message,
				replyHandle: message.replyHandle,
				text: "fixture",
			}),
		).toBe("failed");
		await sql`update platform.wecom_connections set lease_until=now()-interval '1 second'`;
		await second.tick();
		await expect.poll(() => auths).toBe(2);
		await first.tick();
		expect(
			await first.sender.send({
				scope: message,
				replyHandle: message.replyHandle,
				text: "fixture",
			}),
		).toBe("failed");
		expect(
			await second.sender.send({
				scope: message,
				replyHandle: message.replyHandle,
				text: "fixture",
			}),
		).toBe("failed");
		expect(replies).toBe(1);
	} finally {
		await first.close();
		await second.close();
		await sql.end();
		for (const client of server.clients) client.terminate();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await db.stop();
	}
}, 30000);
