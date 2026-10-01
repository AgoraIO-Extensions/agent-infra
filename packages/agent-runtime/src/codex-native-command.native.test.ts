import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, get, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CodexAppServerBridge,
	type CodexAppServerBridgeOptions,
	type CodexAppServerFrame,
	codexConversationKey,
} from "./codex-app-server-bridge.js";
import { verifyCodexPilotInstallation } from "./codex-installation.js";
import { seedNativeCommandState } from "./codex-native-command.test-support.js";
import { CodexRuntimeDriver } from "./codex-runtime-driver.js";

class ObservedNativeDriver extends CodexRuntimeDriver {
	static openObserved(
		path: string,
		endpoint: string,
		open: (
			options: CodexAppServerBridgeOptions,
		) => Promise<CodexAppServerBridge>,
	) {
		return ObservedNativeDriver.openWithBridge(
			{
				path,
				nativeLane: "official-model-only",
				configVersion: "native-read-config-1",
				defaultModelOptionId: "primary",
				defaultReasoningLevel: "high",
				modelOptions: [
					{
						modelOptionId: "primary",
						model: "gpt-5.6-sol",
						reasoningLevels: ["high"],
						endpoint,
						credential: "synthetic-native-read-credential",
					},
				],
				authorizeExternalAction: async () => {
					throw new Error("Metadata read attempted model authorization");
				},
			},
			open,
		);
	}
}

async function positiveHttpControl(endpoint: string) {
	await new Promise<void>((resolve, reject) => {
		get(`${endpoint}/observer-control`, (response) => {
			response.resume();
			response.on("end", resolve);
		}).on("error", reject);
	});
}

// Opt-in only: execute in the fixed official Linux image during a named resource window.
describe.skipIf(process.env.AGENT_INFRA_CODEX_NATIVE_TEST !== "1")(
	"Codex native metadata command (official binary, controlled persisted storage)",
	() => {
		it("reads the original unloaded thread with zero provider/model HTTP and no business writes", async () => {
			await verifyCodexPilotInstallation();
			const directory = await mkdtemp(join(tmpdir(), "codex-native-read-"));
			try {
				const threadId = randomUUID();
				const { path, nativeSessionRef, binding } =
					await seedNativeCommandState(directory, threadId);
				const root = join(
					`${path}.native`,
					"conversations",
					codexConversationKey(binding.scope),
				);
				const workspace = join(root, "workspace");
				const sessions = join(root, "home", "sessions", "2026", "10", "01");
				await mkdir(workspace, { recursive: true, mode: 0o700 });
				await mkdir(sessions, { recursive: true, mode: 0o700 });
				// Pinned upstream SessionMetaLine / RolloutLine schema. No native start/resume/Turn is used to seed it.
				const rollout = join(
					sessions,
					`rollout-2026-10-01T00-00-00-${threadId}.jsonl`,
				);
				const timestamp = "2026-10-01T00:00:00.000Z";
				await writeFile(
					rollout,
					`${JSON.stringify({
						timestamp,
						type: "session_meta",
						payload: {
							session_id: threadId,
							id: threadId,
							timestamp,
							cwd: workspace,
							originator: "agent-infra-native-read-test",
							cli_version: "0.153.0",
							source: "cli",
							model_provider: "agent_infra",
							base_instructions: null,
							history_mode: "paginated",
						},
					})}\n`,
				);
				const driverBefore = await readFile(path);
				const rolloutBefore = await readFile(rollout);
				const requests: { method: unknown; params: unknown }[] = [];
				const notifications: unknown[] = [];
				const httpByPort = new Map<number, number>();
				const httpChannel = channel("http.server.request.start");
				const observer = (event: unknown) => {
					const address = (event as { server: Server }).server.address();
					if (address && typeof address !== "string")
						httpByPort.set(
							address.port,
							(httpByPort.get(address.port) ?? 0) + 1,
						);
				};
				httpChannel.subscribe(observer);
				const provider = createServer((_, response) => {
					response.writeHead(503);
					response.end();
				});
				let driver: CodexRuntimeDriver | undefined;
				try {
					await new Promise<void>((resolve) =>
						provider.listen(0, "127.0.0.1", resolve),
					);
					const address = provider.address();
					if (!address || typeof address === "string")
						throw new Error("Missing provider listener");
					const endpoint = `http://127.0.0.1:${address.port}`;
					await positiveHttpControl(endpoint);
					expect(httpByPort.get(address.port)).toBe(1);
					driver = await ObservedNativeDriver.openObserved(
						path,
						endpoint,
						async (options) => {
							if (!options.modelAccess)
								throw new Error("Missing original model transport");
							const modelPort = Number(
								new URL(options.modelAccess.endpoint).port,
							);
							await positiveHttpControl(options.modelAccess.endpoint);
							expect(httpByPort.get(modelPort)).toBe(1);
							const bridge = await CodexAppServerBridge.open(options);
							// Observe actual wire calls; delegate every send and frame to the official process.
							const send = bridge.send.bind(bridge);
							bridge.send = async (frame: CodexAppServerFrame) => {
								requests.push({ method: frame.method, params: frame.params });
								return send(frame);
							};
							const frames = bridge.frames.bind(bridge);
							bridge.frames = async function* () {
								for await (const frame of frames()) {
									if ("method" in frame) notifications.push(frame.method);
									yield frame;
								}
							};
							return bridge;
						},
					);
					const read = {
						nativeSessionRef,
						signal: new AbortController().signal,
						expiresAt: Date.now() + 60_000,
						assertCurrent: () => binding,
					};
					const catalog = await driver.discoverNativeCommands(read);
					const status = await driver.readNativeStatus(
						{
							capabilityId: catalog.capabilities[0]?.id as string,
							directoryRevision: catalog.revision,
							parameters: {},
						},
						read,
					);
					expect(status).toEqual({
						status: "not_loaded",
						readAt: expect.any(String),
					});
					expect(JSON.stringify([catalog, status])).not.toContain(threadId);
					expect(requests.map((request) => request.method)).toEqual([
						"initialize",
						"config/read",
						"model/list",
						"thread/read",
						"thread/read",
					]);
					for (const request of requests.filter(
						(request) => request.method === "thread/read",
					))
						expect(request.params).toEqual({ threadId, includeTurns: false });
					for (const method of [
						"thread/started",
						"turn/started",
						"turn/completed",
					])
						expect(notifications).not.toContain(method);
					await driver.close();
					driver = undefined;
					// The only HTTP events are the two independently checked positive observer controls.
					expect(
						[...httpByPort.values()].reduce((sum, count) => sum + count, 0),
					).toBe(2);
					expect(await readFile(path)).toEqual(driverBefore);
					expect(await readFile(rollout)).toEqual(rolloutBefore);
				} finally {
					try {
						await driver?.close();
					} finally {
						httpChannel.unsubscribe(observer);
						await new Promise<void>((resolve, reject) =>
							provider.close((error) => (error ? reject(error) : resolve())),
						);
					}
				}
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		}, 90_000);
	},
);
