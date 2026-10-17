import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { RuntimeManifestV1Schema } from "@agent-infra/contracts/workload";
import { expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixtureRoot = join(repositoryRoot, "tests/fixtures/custom-agent-acp");

function nextFrame(input: ReturnType<typeof createInterface>) {
	return new Promise<Record<string, unknown>>((resolve, reject) => {
		const onLine = (line: string) => {
			input.off("line", onLine);
			try {
				resolve(JSON.parse(line) as Record<string, unknown>);
			} catch (error) {
				reject(error);
			}
		};
		input.on("line", onLine);
	});
}

it("packages a controlled custom ACP image with a valid platform manifest", async () => {
	const dockerfile = await readFile(join(fixtureRoot, "Dockerfile"), "utf8");
	const manifestText = dockerfile.match(
		/LABEL io\.agora\.agent\.runtime\.manifest='([^']+)'/,
	)?.[1];
	expect(dockerfile).toMatch(/^FROM node@sha256:[a-f0-9]{64}$/m);
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
	try {
		peer.stdin.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: 1 },
			})}\n`,
		);
		expect(await nextFrame(output)).toMatchObject({
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
		expect(await nextFrame(output)).toMatchObject({
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
		expect(await nextFrame(output)).toMatchObject({
			method: "session/update",
			params: {
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { text: "controlled custom ACP image result 1" },
				},
			},
		});
		expect(await nextFrame(output)).toMatchObject({
			id: 3,
			result: { stopReason: "end_turn" },
		});
	} finally {
		output.close();
		peer.kill();
		await new Promise<void>((resolve) => peer.once("close", () => resolve()));
	}
});
