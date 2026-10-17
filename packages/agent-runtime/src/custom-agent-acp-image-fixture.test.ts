import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { RuntimeManifestV1Schema } from "@agent-infra/contracts/workload";
import { expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixtureRoot = join(repositoryRoot, "tests/fixtures/custom-agent-acp");

function createFrameReader(input: ReturnType<typeof createInterface>) {
	const queue: Record<string, unknown>[] = [];
	const waiters: {
		resolve: (frame: Record<string, unknown>) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}[] = [];
	let closed = false;
	const onLine = (line: string) => {
		let frame: Record<string, unknown>;
		try {
			frame = JSON.parse(line) as Record<string, unknown>;
		} catch (error) {
			waiters.shift()?.reject(error as Error);
			return;
		}
		const waiter = waiters.shift();
		if (waiter) {
			clearTimeout(waiter.timer);
			waiter.resolve(frame);
		} else queue.push(frame);
	};
	const onClose = () => {
		closed = true;
		for (const waiter of waiters.splice(0)) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error("ACP peer closed before sending a frame"));
		}
	};
	input.on("line", onLine);
	input.once("close", onClose);
	return {
		next(label: string, timeoutMs = 5000) {
			if (queue.length > 0)
				return Promise.resolve(queue.shift() as Record<string, unknown>);
			if (closed)
				return Promise.reject(
					new Error(`ACP peer closed before sending a frame: ${label}`),
				);
			return new Promise<Record<string, unknown>>((resolve, reject) => {
				const timer = setTimeout(() => {
					const index = waiters.findIndex((waiter) => waiter.timer === timer);
					if (index >= 0) waiters.splice(index, 1);
					reject(new Error(`Timed out waiting for ACP frame: ${label}`));
				}, timeoutMs);
				waiters.push({ resolve, reject, timer });
			});
		},
		close() {
			input.off("line", onLine);
			input.off("close", onClose);
		},
	};
}

it("packages a controlled custom ACP image with a valid platform manifest", async () => {
	const dockerfile = await readFile(join(fixtureRoot, "Dockerfile"), "utf8");
	const peerSource = await readFile(join(fixtureRoot, "peer.mjs"), "utf8");
	const manifestText = dockerfile.match(
		/LABEL io\.agora\.agent\.runtime\.manifest='([^']+)'/,
	)?.[1];
	expect(dockerfile).toMatch(/^FROM node@sha256:[a-f0-9]{64}$/m);
	expect(peerSource).not.toMatch(/open\s*code/i);
	expect(manifestText).toBeDefined();
	const manifest = RuntimeManifestV1Schema.parse(
		JSON.parse(manifestText ?? "{}"),
	);
	expect(manifest).toMatchObject({
		interactionMode: "platform-adapter",
		protocol: "acp",
		service: { port: 3003 },
		health: { path: "/healthz" },
		capabilities: { modelSelection: true },
	});

	const peer = spawn(process.execPath, [join(fixtureRoot, "peer.mjs")], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	const output = createInterface({ input: peer.stdout });
	const frames = createFrameReader(output);
	try {
		peer.stdin.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: 1 },
			})}\n`,
		);
		expect(await frames.next("initialize")).toMatchObject({
			id: 1,
			result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
		});

		peer.stdin.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "session/new",
				params: { cwd: "/fixture", mcpServers: [] },
			})}\n`,
		);
		expect(await frames.next("session/new")).toMatchObject({
			id: 2,
			result: {
				sessionId: "controlled-custom-acp-image-v1",
				configOptions: expect.arrayContaining([
					expect.objectContaining({ currentValue: "fixture/custom-model" }),
				]),
			},
		});

		peer.stdin.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: 3,
				method: "session/prompt",
				params: { sessionId: "controlled-custom-acp-image-v1", prompt: [] },
			})}\n`,
		);
		expect(await frames.next("session/update")).toMatchObject({
			method: "session/update",
			params: {
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { text: "controlled custom ACP image result 1" },
				},
			},
		});
		expect(await frames.next("session/prompt")).toMatchObject({
			id: 3,
			result: { stopReason: "end_turn" },
		});
	} finally {
		const exited = new Promise<void>((resolve) =>
			peer.once("close", () => resolve()),
		);
		frames.close();
		output.close();
		peer.kill();
		await exited;
	}
});
