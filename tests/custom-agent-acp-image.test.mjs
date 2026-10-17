import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const fixtureRoot = join(import.meta.dirname, "fixtures/custom-agent-acp");

function createFrameReader(input) {
	const queue = [];
	const waiters = [];
	let closed = false;
	const onLine = (line) => {
		let frame;
		try {
			frame = JSON.parse(line);
		} catch (error) {
			const waiter = waiters.shift();
			if (waiter) waiter.reject(error);
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
			waiter.reject(new Error("ACP image closed before sending a frame"));
		}
	};
	input.on("line", onLine);
	input.once("close", onClose);
	return {
		next(label, timeoutMs = 10_000) {
			if (queue.length > 0) return Promise.resolve(queue.shift());
			if (closed)
				return Promise.reject(
					new Error(`ACP image closed before sending a frame: ${label}`),
				);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					const index = waiters.findIndex((waiter) => waiter.timer === timer);
					if (index >= 0) waiters.splice(index, 1);
					reject(new Error(`Timed out waiting for ACP image frame: ${label}`));
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

test("builds and runs the controlled custom ACP image", async (t) => {
	const tag = `agent-infra-custom-acp-fixture:${process.pid}`;
	const containerName = `agent-infra-custom-acp-fixture-${process.pid}`;
	try {
		try {
			await exec(
				"docker",
				["build", "--pull=false", "--tag", tag, fixtureRoot],
				{ timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
			);
		} catch (error) {
			if (error?.code === "ENOENT") {
				t.skip("Docker is unavailable in this environment");
				return;
			}
			throw error;
		}

		const peer = spawn(
			"docker",
			["run", "--rm", "--name", containerName, "--interactive", tag],
			{
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		const output = createInterface({ input: peer.stdout });
		const frames = createFrameReader(output);
		try {
			const send = (frame) => peer.stdin.write(`${JSON.stringify(frame)}\n`);
			send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
			assert.deepEqual(await frames.next("initialize"), {
				jsonrpc: "2.0",
				id: 1,
				result: {
					protocolVersion: 1,
					agentCapabilities: { loadSession: true },
					agentInfo: { name: "controlled-custom-acp-image", version: "1" },
				},
			});

			send({
				jsonrpc: "2.0",
				id: 2,
				method: "session/new",
				params: { cwd: "/fixture", mcpServers: [] },
			});
			const session = await frames.next("session/new");
			assert.equal(session.result.sessionId, "controlled-custom-acp-image-v1");

			send({
				jsonrpc: "2.0",
				id: 3,
				method: "session/prompt",
				params: { sessionId: session.result.sessionId, prompt: [] },
			});
			assert.deepEqual(await frames.next("session/update"), {
				jsonrpc: "2.0",
				method: "session/update",
				params: {
					sessionId: "controlled-custom-acp-image-v1",
					update: {
						sessionUpdate: "agent_message_chunk",
						content: {
							type: "text",
							text: "controlled custom ACP image result 1",
						},
					},
				},
			});
			assert.deepEqual(await frames.next("session/prompt"), {
				jsonrpc: "2.0",
				id: 3,
				result: { stopReason: "end_turn" },
			});
		} finally {
			const exited = new Promise((resolve) => peer.once("close", resolve));
			frames.close();
			output.close();
			await exec("docker", ["rm", "--force", containerName]).catch(() => {});
			peer.kill();
			await exited;
		}
	} finally {
		await exec("docker", ["image", "rm", "--force", tag]).catch(() => {});
	}
});
