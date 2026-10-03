import { channel } from "node:diagnostics_channel";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCodexInstalledSkillDeployment } from "../../../apps/agent-runtime-host/src/installed-skill.ts";
import {
	CodexAppServerBridge,
	type CodexAppServerFrame,
} from "./codex-app-server-bridge.js";
import { verifyCodexPilotInstallation } from "./codex-installation.js";
import { seedNativeCommandState } from "./codex-native-command.test-support.js";
import { CodexRuntimeDriver } from "./codex-runtime-driver.js";

class ObservedNativeSkillDriver extends CodexRuntimeDriver {
	static async openObserved(
		options: Parameters<typeof CodexRuntimeDriver.open>[0],
		requests: CodexAppServerFrame[],
		notifications: string[],
	) {
		return ObservedNativeSkillDriver.openWithBridge(
			options,
			async (bridgeOptions) => {
				const bridge = await CodexAppServerBridge.open(bridgeOptions);
				const send = bridge.send.bind(bridge);
				bridge.send = async (frame) => {
					requests.push(frame);
					return send(frame);
				};
				const frames = bridge.frames.bind(bridge);
				bridge.frames = async function* () {
					for await (const frame of frames()) {
						if ("method" in frame && typeof frame.method === "string")
							notifications.push(frame.method);
						yield frame;
					}
				};
				return bridge;
			},
		);
	}
}

describe.skipIf(process.env.AGENT_INFRA_CODEX_NATIVE_TEST !== "1")(
	"Codex native installed Skill discovery",
	() => {
		it("consumes the official set/list frames and invalidates on changed", async () => {
			await verifyCodexPilotInstallation("workspace-summary-v1");
			const descriptor = await readCodexInstalledSkillDeployment(
				process.env,
				"config-1",
			);
			if (!descriptor) throw new Error("Missing installed Skill descriptor");
			const directory = await mkdtemp(join(tmpdir(), "codex-native-skill-"));
			const provider = createServer((_, response) => {
				response.writeHead(503);
				response.end();
			});
			const secondaryProvider = createServer((_, response) => {
				response.writeHead(503);
				response.end();
			});
			const requests: CodexAppServerFrame[] = [];
			const notifications: string[] = [];
			const http = channel("http.server.request.start");
			const httpByPort = new Map<number, number>();
			const observe = (event: unknown) => {
				const address = (event as { server: Server }).server.address();
				if (address && typeof address !== "string")
					httpByPort.set(address.port, (httpByPort.get(address.port) ?? 0) + 1);
			};
			http.subscribe(observe);
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
								model: "gpt-5.6-sol",
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
				);
				const read = {
					nativeSessionRef: seeded.nativeSessionRef,
					signal: new AbortController().signal,
					expiresAt: Date.now() + 60_000,
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
				expect(httpByPort.get(address.port) ?? 0).toBe(0);
				expect(httpByPort.get(secondaryAddress.port) ?? 0).toBe(0);
			} finally {
				await driver?.close();
				http.unsubscribe(observe);
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
