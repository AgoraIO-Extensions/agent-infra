import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { GenericAcpRuntimeDriver } from "./acp-runtime-driver.js";
import { retireNativeProcess } from "./native-process.js";
import { PiRuntimeDriver } from "./pi-runtime-driver.js";

it.each([
	{ runtime: "acp", keepAlive: false },
	{ runtime: "pi", keepAlive: false },
	{ runtime: "acp", keepAlive: true },
	{ runtime: "pi", keepAlive: true },
] as const)(
	"retires the owned orphan after a Host crash before resuming the original session (%j)",
	async ({ runtime, keepAlive }) => {
		const path = await mkdtemp(join(tmpdir(), "native-host-crash-"));
		const host = spawn(
			process.execPath,
			[
				"--experimental-transform-types",
				fileURLToPath(
					new URL("./native-host-crash.test-support.mjs", import.meta.url),
				),
				path,
				runtime,
				String(keepAlive),
			],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		host.stderr.resume();
		const hostExit = once(host, "exit");
		let driver: GenericAcpRuntimeDriver | undefined;
		try {
			const [output] = await Promise.race([
				once(host.stdout, "data"),
				hostExit.then(() => {
					throw new Error("Synthetic Host exited before completion");
				}),
			]);
			const accepted = JSON.parse(output.toString());
			const owner = JSON.parse(
				await readFile(
					join(path, accepted.nativeSessionRef, "process.json"),
					"utf8",
				),
			).owner;
			expect(() => process.kill(owner.pid, 0)).not.toThrow();
			host.kill("SIGKILL");
			await hostExit;
			driver = await (runtime === "acp"
				? GenericAcpRuntimeDriver
				: PiRuntimeDriver
			).open({
				path,
				configVersion: "configuration-a",
				defaultModelOptionId: "primary",
				defaultReasoningLevel: "high",
				modelOptions: [
					{
						modelOptionId: "primary",
						nativeModelId:
							runtime === "acp" ? "provider/model" : "configured/model",
						reasoningLevels: ["high"],
					},
				],
				launch: async () => ({
					command: process.execPath,
					args: [
						fileURLToPath(
							new URL(`./${runtime}-peer.test-support.mjs`, import.meta.url),
						),
					],
					env: {},
				}),
			});
			expect(
				await driver.getStatus(accepted.nativeSessionRef, "execution-a"),
			).toBe("completed");
			const previousEvents = await driver.replayEvents(
				accepted.nativeSessionRef,
				"execution-a",
			);
			const stateFile = join(path, accepted.nativeSessionRef, "state.json");
			const nativeId = JSON.parse(await readFile(stateFile, "utf8")).nativeId;
			const next = await driver.execute({
				schemaVersion: 2,
				kind: "submit-turn",
				agentId: "agent-a",
				conversationId: "conversation-a",
				sessionGeneration: 1,
				nativeSessionRef: accepted.nativeSessionRef,
				executionId: "execution-b",
				turnId: "turn-b",
				operationId: "operation-b",
				input: { text: "synthetic input", attachments: [] },
				selection: {
					schemaVersion: 1,
					modelOptionId: "primary",
					reasoningLevel: "high",
				},
			});
			await vi.waitFor(async () =>
				expect(
					await driver?.getStatus(next.nativeSessionRef, "execution-b"),
				).toBe("completed"),
			);
			expect(
				(await driver.replayEvents(next.nativeSessionRef, "execution-b"))
					.filter((e) => e.type === "text")
					.map((e) => e.payload.delta)
					.join(""),
			).toBe(runtime === "acp" ? "synthetic result 2" : "synthetic result");
			expect(next.nativeSessionRef).toBe(accepted.nativeSessionRef);
			expect(JSON.parse(await readFile(stateFile, "utf8")).nativeId).toBe(
				nativeId,
			);
			expect(
				await driver.replayEvents(accepted.nativeSessionRef, "execution-a"),
			).toEqual(previousEvents);
			expect(() => process.kill(-owner.pid, 0)).toThrow();
		} finally {
			host.kill("SIGKILL");
			await hostExit;
			await driver?.close();
			// A failed assertion may precede recovery. Retire every owned peer
			// independently before removing this test's isolated state directory.
			for (const entry of await readdir(path, { withFileTypes: true })) {
				if (entry.isDirectory())
					await retireNativeProcess(
						join(path, entry.name),
						runtime === "acp"
							? "AGENT_INFRA_ACP_OWNER"
							: "AGENT_INFRA_PI_OWNER",
					);
			}
			await rm(path, { recursive: true, force: true });
		}
	},
	15_000,
);
