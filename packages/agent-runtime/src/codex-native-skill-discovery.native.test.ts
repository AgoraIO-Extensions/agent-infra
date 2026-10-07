import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCodexInstalledSkillDeployment } from "../../../apps/agent-runtime-host/src/configuration.ts";
import {
	CodexAppServerBridge,
	type CodexAppServerFrame,
} from "./codex-app-server-bridge.js";
import { verifyCodexPilotInstallation } from "./codex-installation.js";
import { seedNativeCommandState } from "./codex-native-command.test-support.js";
import { CodexRuntimeDriver } from "./codex-runtime-driver.js";
import { codexSkillLaunch } from "./codex-skill-launch.internal.js";

function evidenceValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(evidenceValue);
	if (typeof value !== "object" || value === null) return value;
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		result[key] = /credential|token|secret|password|authorization/i.test(key)
			? "[redacted]"
			: evidenceValue(item);
	}
	return result;
}

class ObservedNativeSkillDriver extends CodexRuntimeDriver {
	static async openObserved(
		options: Parameters<typeof CodexRuntimeDriver.open>[0],
		requests: CodexAppServerFrame[],
		notifications: string[],
		responses: Array<{ method: string; frame: CodexAppServerFrame }>,
		launches: Array<{
			processId: string;
			cwd: string;
			bundledSkillsDisabled: boolean;
		}>,
	) {
		return ObservedNativeSkillDriver.openWithBridge(
			options,
			async (bridgeOptions) => {
				const bridge = await CodexAppServerBridge.open(bridgeOptions);
				const requestMethods = new Map<string, string>();
				const send = bridge.send.bind(bridge);
				bridge.send = async (frame) => {
					requests.push(frame);
					if (
						"id" in frame &&
						(typeof frame.id === "string" || typeof frame.id === "number")
					)
						requestMethods.set(String(frame.id), String(frame.method));
					return send(frame);
				};
				const frames = bridge.frames.bind(bridge);
				bridge.frames = async function* () {
					for await (const frame of frames()) {
						if ("method" in frame && typeof frame.method === "string")
							notifications.push(frame.method);
						else if (
							"id" in frame &&
							(typeof frame.id === "string" || typeof frame.id === "number")
						) {
							const method = requestMethods.get(String(frame.id));
							if (method) responses.push({ method, frame });
						}
						yield frame;
					}
				};
				const launch = bridge[codexSkillLaunch];
				if (launch) {
					launches.push({
						processId: launch.processId,
						cwd: launch.cwd,
						bundledSkillsDisabled: launch.bundledSkillsDisabled,
					});
				}
				return bridge;
			},
		);
	}
}

describe.skipIf(process.env.AGENT_INFRA_CODEX_NATIVE_TEST !== "1")(
	"Codex native installed Skill discovery",
	() => {
		it("consumes the official set/list frames and records changed", async () => {
			await verifyCodexPilotInstallation("workspace-summary-v1");
			const descriptor = await readCodexInstalledSkillDeployment(
				process.env,
				"config-1",
			);
			if (!descriptor) throw new Error("Missing installed Skill descriptor");
			const directory = await mkdtemp(join(tmpdir(), "codex-native-skill-"));
			let providerRequests = 0;
			const provider = createServer((_, response) => {
				providerRequests++;
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ model: "primary" }));
			});
			let secondaryProviderRequests = 0;
			const secondaryProvider = createServer((_, response) => {
				secondaryProviderRequests++;
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ model: "secondary" }));
			});
			const requests: CodexAppServerFrame[] = [];
			const notifications: string[] = [];
			const responses: Array<{
				method: string;
				frame: CodexAppServerFrame;
			}> = [];
			const launches: Array<{
				processId: string;
				cwd: string;
				bundledSkillsDisabled: boolean;
			}> = [];
			let driver: CodexRuntimeDriver | undefined;
			try {
				await new Promise<void>((resolve) =>
					provider.listen(0, "127.0.0.1", resolve),
				);
				await new Promise<void>((resolve) =>
					secondaryProvider.listen(0, "127.0.0.1", resolve),
				);
				const address = provider.address();
				const secondaryAddress = secondaryProvider.address();
				if (
					!address ||
					typeof address === "string" ||
					!secondaryAddress ||
					typeof secondaryAddress === "string"
				)
					throw new Error("Missing providers");
				const endpoint = `http://127.0.0.1:${address.port}`;
				const secondaryEndpoint = `http://127.0.0.1:${secondaryAddress.port}`;
				for (const [control, model] of [
					[endpoint, "primary"],
					[secondaryEndpoint, "secondary"],
				] as const) {
					const response = await fetch(control);
					expect(response.status).toBe(200);
					await expect(response.json()).resolves.toEqual({ model });
				}
				expect(providerRequests).toBe(1);
				expect(secondaryProviderRequests).toBe(1);
				const seeded = await seedNativeCommandState(
					directory,
					"native-skill-thread",
				);
				driver = await ObservedNativeSkillDriver.openObserved(
					{
						path: seeded.path,
						nativeLane: "official-model-only",
						configVersion: "config-1",
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
							{
								modelOptionId: "secondary",
								model: "gpt-5.6-luna",
								reasoningLevels: ["high"],
								endpoint: secondaryEndpoint,
								credential: "synthetic-native-read-credential-2",
							},
						],
						installedSkill: descriptor,
						authorizeExternalAction: async () => {
							throw new Error("Skill discovery attempted model authorization");
						},
					},
					requests,
					notifications,
					responses,
					launches,
				);
				const read = {
					nativeSessionRef: seeded.nativeSessionRef,
					signal: new AbortController().signal,
					expiresAt: Date.now() + 30_000,
					assertCurrent: () => seeded.binding,
					revalidate: async () => seeded.binding,
				};
				const first = await driver.discoverNativeSkills(read);
				expect(first.capabilities).toHaveLength(1);
				expect(first.capabilities[0]).toMatchObject({
					name: "workspace-summary",
					availability: "discovered",
				});
				expect(JSON.stringify(first)).not.toContain("/opt/codex");
				expect(JSON.stringify(first)).not.toContain("native-skill-thread");
				const persisted = await readFile(seeded.path);
				expect(persisted.toString()).not.toContain("workspace-summary");
				const set = requests.find(
					(request) => request.method === "skills/extraRoots/set",
				);
				expect(set?.params).toEqual({
					extraRoots: [descriptor.manifest.extraRoot],
				});
				const list = requests.find(
					(request) => request.method === "skills/list",
				);
				expect(list?.params).toMatchObject({ forceReload: true });
				if (!list) throw new Error("Missing skills/list request");
				expect((list.params as { cwds?: unknown }).cwds).toEqual([
					expect.any(String),
				]);
				expect(notifications).toContain("skills/changed");
				expect(requests.map((request) => request.method)).toEqual([
					// The pinned app-server performs its normal startup handshake before
					// the Driver can issue the Skill discovery calls.
					"initialize",
					"config/read",
					"model/list",
					"skills/extraRoots/set",
					"skills/list",
				]);
				expect(providerRequests).toBe(1);
				expect(secondaryProviderRequests).toBe(1);
				expect(launches).toHaveLength(1);
				expect(launches[0]).toMatchObject({
					bundledSkillsDisabled: true,
					cwd: expect.any(String),
					processId: expect.any(String),
				});
				expect(
					responses.filter(({ method }) =>
						["config/read", "skills/extraRoots/set", "skills/list"].includes(
							method,
						),
					),
				).toHaveLength(3);
				console.log(
					`NATIVE_SKILL_EVIDENCE ${JSON.stringify({
						launches,
						requests: evidenceValue(
							requests.filter(
								(request) =>
									typeof request.method === "string" &&
									[
										"config/read",
										"skills/extraRoots/set",
										"skills/list",
									].includes(request.method),
							),
						),
						responses: evidenceValue(responses),
						notifications,
						providerRequests,
						secondaryProviderRequests,
					})}`,
				);
			} finally {
				await driver?.close();
				await new Promise<void>((resolve, reject) =>
					provider.close((error) => (error ? reject(error) : resolve())),
				);
				await new Promise<void>((resolve, reject) =>
					secondaryProvider.close((error) =>
						error ? reject(error) : resolve(),
					),
				);
				await rm(directory, { recursive: true, force: true });
			}
		});
	},
);
