import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CODEX_OFFICIAL_LANE_CONFIG,
	type CodexAppServerBridgeOptions,
	type CodexAppServerFrame,
} from "../../../packages/agent-runtime/src/codex-app-server-bridge.js";
import { seedNativeCommandState } from "../../../packages/agent-runtime/src/codex-native-command.test-support.js";
import { CodexRuntimeDriver } from "../../../packages/agent-runtime/src/codex-runtime-driver.js";
import {
	type CodexSkillLaunchProvenance,
	codexSkillLaunch,
} from "../../../packages/agent-runtime/src/codex-skill-launch.internal.js";
import { measureNativeMetadataPgChain } from "../../../tests/support/native-metadata-postgres-chain.js";

// This test owns only a metadata protocol double; every business method is forbidden.
class MetadataBridge {
	readonly requests: CodexAppServerFrame[] = [];
	options?: CodexAppServerBridgeOptions;
	onProjection?: () => void;
	launch?: CodexSkillLaunchProvenance;
	private readonly queue: CodexAppServerFrame[] = [];
	private wake?: () => void;
	private closed = false;
	get [codexSkillLaunch]() {
		return this.launch;
	}
	async send(frame: CodexAppServerFrame) {
		this.requests.push(frame);
		const projected = () => this.onProjection?.();
		if (frame.method === "initialize") this.respond(frame, {});
		else if (frame.method === "config/read") {
			const config: Record<string, unknown> = {
				model: this.options?.model,
				model_reasoning_effort: "high",
				mcp_servers: {},
				plugins: {},
				marketplaces: {},
				features: { plugins: false },
			};
			const origins: Record<string, unknown> = Object.fromEntries(
				["model", "model_reasoning_effort", "features.plugins"].map((key) => [
					key,
					{ name: { type: "sessionFlags" }, version: "1" },
				]),
			);
			for (const [key, value] of Object.entries(CODEX_OFFICIAL_LANE_CONFIG)) {
				const parts = key.split(".");
				let container = config;
				for (const part of parts.slice(0, -1)) {
					container[part] ??= {};
					container = container[part] as Record<string, unknown>;
				}
				container[parts.at(-1) as string] = structuredClone(value);
				// 固定 Codex 按元素记录数组配置的来源。
				for (const originKey of Array.isArray(value)
					? value.map((_, index) => `${key}.${index}`)
					: [key])
					origins[originKey] = { name: { type: "sessionFlags" }, version: "1" };
			}
			const provider = {
				name: "Agent Infra Active Model",
				base_url: this.options?.modelAccess?.endpoint,
				env_key: "AGENT_INFRA_CODEX_MODEL_CREDENTIAL",
				wire_api: "responses",
				requires_openai_auth: false,
				supports_websockets: false,
				request_max_retries: 0,
				stream_max_retries: 0,
				env_key_instructions: null,
				experimental_bearer_token: null,
				auth: null,
				aws: null,
				query_params: null,
				http_headers: null,
				env_http_headers: null,
				stream_idle_timeout_ms: null,
				websocket_connect_timeout_ms: null,
				supports_standalone_web_search: false,
			};
			config.model_provider = "agent_infra";
			config.model_providers = { agent_infra: provider };
			origins.model_provider = { name: { type: "sessionFlags" }, version: "1" };
			for (const [key, value] of Object.entries(provider)) {
				if (value !== null && key !== "supports_standalone_web_search")
					origins[`model_providers.agent_infra.${key}`] = {
						name: { type: "sessionFlags" },
						version: "1",
					};
			}
			config.skills = { bundled: { enabled: false } };
			origins["skills.bundled.enabled"] = {
				name: { type: "sessionFlags" },
				version: "1",
			};

			this.respond(frame, { config, origins });
		} else if (frame.method === "skills/extraRoots/set") {
			this.push({ method: "skills/changed", params: {} });
			this.respond(frame, {});
		} else if (frame.method === "skills/list")
			this.respond(frame, {
				data: [
					{
						cwd: this.launch?.cwd,
						skills: [
							{
								name: "workspace-summary",
								get description() {
									projected();
									return "显式选择本 Skill 后，读取当前授权工作区中的指定文本文件并给出有来源依据的摘要。";
								},
								path: "/opt/codex/agent-infra-skills/workspace-summary/SKILL.md",
								scope: "user",
								enabled: true,
								pluginId: null,
							},
						],
						errors: [],
					},
				],
			});
		else if (frame.method === "thread/read")
			this.respond(frame, {
				thread: {
					id: "native-thread-private",
					status: {
						get type() {
							projected();
							return "notLoaded";
						},
					},
					turns: [],
				},
			});
		else throw new Error("Unexpected business RPC in metadata-only fixture");
	}
	private respond(frame: CodexAppServerFrame, result: unknown) {
		this.push({ id: frame.id, result });
	}
	private push(frame: CodexAppServerFrame) {
		this.queue.push(frame);
		this.wake?.();
	}
	async *frames() {
		while (!this.closed) {
			const frame = this.queue.shift();
			if (frame) yield frame;
			else
				await new Promise<void>((resolve) => {
					this.wake = resolve;
				});
		}
	}
	async close() {
		this.closed = true;
		this.wake?.();
	}
}

class MetadataDriver extends CodexRuntimeDriver {
	static openFixture(path: string, bridge: MetadataBridge, directory: string) {
		return MetadataDriver.openWithBridge(
			{
				path,
				nativeLane: "official-model-only",
				configVersion: "config-1",
				defaultModelOptionId: "primary",
				defaultReasoningLevel: "high",
				installedSkill: installedSkillDescriptor("config-1"),
				authorizeExternalAction: async () => {
					throw new Error("Unexpected model call");
				},
				modelOptions: [
					{
						modelOptionId: "primary",
						model: "gpt-5.3-codex",
						reasoningLevels: ["high"],
						endpoint: "http://127.0.0.1:1/approved/v1",
						credential: "synthetic-model-credential",
					},
				],
			},
			async (options) => {
				bridge.options = options;
				bridge.launch = Object.freeze({
					transport: bridge,
					processId: "pg-metadata-process",
					conversationKey: options.conversationKey,
					cwd: join(directory, "workspace"),
					bundledSkillsDisabled: options.disableBundledSkills === true,
				});
				return bridge;
			},
		);
	}
}

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "metadata-completion-pg-"));
	try {
		const seed = await seedNativeCommandState(directory);
		const bridge = new MetadataBridge();
		const driver = await MetadataDriver.openFixture(
			seed.path,
			bridge,
			directory,
		);
		return {
			...seed,
			bridge,
			driver,
			directory,
			read: {
				nativeSessionRef: seed.nativeSessionRef,
				signal: new AbortController().signal,
				expiresAt: Date.now() + 10_000,
				assertCurrent: () => seed.binding,
				revalidate: async () => seed.binding,
			},
		};
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

function installedSkillDescriptor(configVersion = "synthetic-config-1") {
	return {
		schemaVersion: 1,
		manifestSha256:
			"9bbef33672b700f43a6e700263a51fef1a0d534d44bf9d4940af84006f37c2d0",
		manifest: {
			schemaVersion: 1,
			name: "workspace-summary",
			version: "0.1.0-candidate.1",
			source: {
				repository: "AgoraIO-Extensions/agent-infra",
				path: "deploy/runtime/skills/workspace-summary",
			},
			runtime: {
				kind: "codex",
				version: "0.153.0",
				upstreamCommit: "41e22fee981a63b3698df7ed36bad393cda24715",
			},
			extraRoot: "/opt/codex/agent-infra-skills",
			packageRoot: "/opt/codex/agent-infra-skills/workspace-summary",
			entryPath: "/opt/codex/agent-infra-skills/workspace-summary/SKILL.md",
			files: [
				{
					path: "SKILL.md",
					sizeBytes: 1373,
					sha256:
						"af9ba615c92dcf53c6d5742b3d6043e4452b4499e0cdb561f4748033881472b2",
				},
			],
			packageDigest: {
				algorithm: "sha256-json-file-inventory-v1",
				sha256:
					"1ab20d81137fec09e015d9eadf953b37f4514c3b2cc02ead0dd879e7c2a86889",
			},
		},
		deployment: {
			configVersion,
			// A real main commit is a fixture value, not proof of an installed image.
			imageSourceRevision: "c3703372198d7b7de5d6d52aec90f7de45507d9e",
		},
	} satisfies NonNullable<
		Parameters<typeof CodexRuntimeDriver.open>[0]["installedSkill"]
	>;
}

describe("native metadata completion across API/Worker/Host/Driver", () => {
	it.each(["revocation", "identity", "agent"] as const)(
		"rejects %s changed during synchronous projection through the actual current/PG chain",
		async (fault) => {
			const f = await fixture();
			try {
				await f.driver.readNativeMetadataV1("skills", f.read);
				const result = await measureNativeMetadataPgChain({
					driver: f.driver,
					nativeSessionRef: f.nativeSessionRef,
					directory: f.directory,
					fault,
					onProjection: (mark) => {
						f.bridge.onProjection = mark;
					},
				});
				expect(result.projected).toBe(true);
				expect(result.rounds).toEqual([[null, null]]);
				expect(result.businessWrites).toEqual({ executions: 0, outbox: 0 });
				expect(
					f.bridge.requests.some((request) => request.method === "turn/start"),
				).toBe(false);
				expect(JSON.stringify(result)).not.toMatch(
					/foreign-agent|foreign-reader|workspace-summary|native-thread-private/,
				);
			} finally {
				await f.driver.close();
				await rm(f.directory, { recursive: true, force: true });
			}
		},
		120_000,
	);

	it.each([false, true])(
		"keeps two metadata rounds and bytes-before-delivery guards with real PG/API/Worker/Host (RTT=%s)",
		async (withRtt) => {
			const f = await fixture();
			try {
				// Warm only the original RPC/process; no read authority is reused.
				await f.driver.readNativeMetadataV1("skills", f.read);
				const result = await measureNativeMetadataPgChain({
					driver: f.driver,
					nativeSessionRef: f.nativeSessionRef,
					directory: f.directory,
					...(withRtt
						? { rtt: { identity: 150, policy: 150, query: 90, current: 100 } }
						: {}),
				});
				process.stdout.write(
					`NATIVE_METADATA_A2_PG ${JSON.stringify(result)}\n`,
				);
				expect(result.rounds).toEqual([
					["commands", "skills"],
					["commands", "skills"],
				]);
				expect(result.counts).toEqual({
					identity: 135,
					policy: 96,
					query: 68,
					current: 28,
				});
				expect(result.elapsedMs).toBeLessThan(30_000);
				expect(result.businessWrites).toEqual({ executions: 0, outbox: 0 });
				expect(
					f.bridge.requests.filter(
						(request) => request.method === "thread/read",
					),
				).toHaveLength(2);
				expect(
					f.bridge.requests.filter(
						(request) => request.method === "skills/list",
					),
				).toHaveLength(3);
				expect(
					f.bridge.requests.some((request) => request.method === "turn/start"),
				).toBe(false);
			} finally {
				await f.driver.close();
				await rm(f.directory, { recursive: true, force: true });
			}
		},
		120_000,
	);
});
