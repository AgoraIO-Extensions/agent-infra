import {
	CODEX_OFFICIAL_LANE_CONFIG,
	type CodexAppServerBridgeOptions,
	type CodexAppServerFrame,
} from "./codex-app-server-bridge.js";
import { CodexRuntimeDriver } from "./codex-runtime-driver.js";
export class MetadataTransport {
	readonly requests: CodexAppServerFrame[] = [];
	options?: CodexAppServerBridgeOptions;
	status: unknown = { type: "notLoaded" };
	threadId = "native-thread-private";
	turns: unknown[] = [];
	error = false;
	errorCode = -32600;
	holdReads = false;
	readonly heldReads: CodexAppServerFrame[] = [];
	closeCount = 0;
	openCount = 0;
	openDelay?: Promise<void>;
	successor?: MetadataTransport;
	beforeSend?: (frame: CodexAppServerFrame) => Promise<void>;
	modelPages = ["gpt-5.3-codex"];
	readSendFailure?: () => Promise<void>;
	beforeResponse?: () => void;
	compactItemId = "context-compaction-item-1";
	compactStartedItemId?: string;
	compactCompletedItemId?: string;
	compactTurnId = "context-compaction-turn-1";
	holdCompactTerminal = false;
	returnTurnsOnStatusRead = false;
	private readonly queue: CodexAppServerFrame[] = [];
	private wake?: () => void;
	private closed = false;

	async send(frame: CodexAppServerFrame) {
		this.requests.push(frame);
		if (this.beforeSend) await this.beforeSend(frame);
		if (frame.method === "initialize" || frame.method === "environment/info")
			this.respond(frame, {});
		else if (frame.method === "environment/status")
			this.respond(frame, { status: "ready" });
		else if (frame.method === "config/read") {
			const config: Record<string, unknown> = {
				model: this.options?.model,
				model_reasoning_effort: this.options?.reasoningEffort ?? "high",
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
			this.respond(frame, { config, origins });
		} else if (frame.method === "model/list") {
			const params = frame.params as { cursor?: string } | undefined;
			const page = Number(params?.cursor ?? 0);
			this.respond(frame, {
				data: [
					{
						model: this.modelPages[page],
						supportedReasoningEfforts: [{ reasoningEffort: "high" }],
					},
				],
				nextCursor: page + 1 < this.modelPages.length ? String(page + 1) : null,
			});
		} else if (frame.method === "thread/read") {
			if (this.readSendFailure) return this.readSendFailure();
			if (this.holdReads) {
				this.heldReads.push(frame);
				return;
			}
			this.releaseRead(frame);
		} else if (frame.method === "thread/compact/start") {
			this.respond(frame, {});
			this.push({
				method: "turn/started",
				params: {
					threadId: this.threadId,
					turn: { id: this.compactTurnId, status: "inProgress", items: [] },
				},
			});
			this.push({
				method: "item/started",
				params: {
					threadId: this.threadId,
					turnId: this.compactTurnId,
					item: {
						type: "contextCompaction",
						id: this.compactStartedItemId ?? this.compactItemId,
					},
				},
			});
			if (!this.holdCompactTerminal) this.completeCompact();
		} else throw new Error(`Unexpected side effect: ${String(frame.method)}`);
	}

	completeCompact() {
		this.push({
			method: "item/completed",
			params: {
				threadId: this.threadId,
				turnId: this.compactTurnId,
				item: {
					type: "contextCompaction",
					id: this.compactCompletedItemId ?? this.compactItemId,
				},
			},
		});
		this.push({
			method: "turn/completed",
			params: {
				threadId: this.threadId,
				turn: { id: this.compactTurnId, status: "completed", items: [] },
			},
		});
	}

	releaseRead(frame = this.heldReads.shift()) {
		if (!frame) throw new Error("Missing held read");
		this.beforeResponse?.();
		if (this.error)
			this.push({
				id: frame.id,
				error: { code: this.errorCode, message: "secret /private/thread/body" },
			});
		else
			this.respond(frame, {
				thread: {
					id: this.threadId,
					status: this.status,
					turns:
						(frame.params as { includeTurns?: boolean } | undefined)
							?.includeTurns === true || this.returnTurnsOnStatusRead
							? this.turns
							: [],
					preview: "private conversation body",
					path: "/private/native/session",
					cwd: "/private/workspace",
					credential: "private-credential",
				},
			});
	}

	private respond(frame: CodexAppServerFrame, result: unknown) {
		this.push({ id: frame.id, result });
	}
	push(frame: CodexAppServerFrame) {
		this.queue.push(frame);
		this.wake?.();
	}
	async *frames() {
		while (!this.closed) {
			const frame = this.queue.shift();
			if (frame) yield frame;
			else await new Promise<void>((resolve) => (this.wake = resolve));
		}
	}
	async close() {
		this.closeCount++;
		this.closed = true;
		this.wake?.();
	}
}

export class MetadataDriver extends CodexRuntimeDriver {
	static openFixture(
		path: string,
		transport: MetadataTransport,
		options: Partial<
			import("./codex-runtime-driver.js").CodexRuntimeDriverOptions
		> = {},
	) {
		let opened = false;
		return MetadataDriver.openWithBridge(
			{
				path,
				nativeLane: "official-model-only",
				configVersion: "config-1",
				defaultModelOptionId: "primary",
				defaultReasoningLevel: "high",
				authorizeExternalAction: async () => {
					throw new Error("Unexpected model authorization");
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
				...options,
			},
			async (options: CodexAppServerBridgeOptions) => {
				const current = opened ? (transport.successor ?? transport) : transport;
				opened = true;
				current.openCount++;
				current.options = options;
				if (current.openDelay) await current.openDelay;
				return current;
			},
		);
	}
}
