import { createHash, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { ApprovedConnectionConsumerTargetV1 } from "@agent-infra/contracts/connection-consumer-profile";
import { RuntimePrincipalV1Schema } from "@agent-infra/contracts/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import Ajv, { type ValidateFunction } from "ajv";

import type { RuntimeOriginalEvidenceBinding } from "./driver.js";
import { RuntimeHostError } from "./errors.js";
import { createCredentialMatcher } from "./model-credential-matcher.js";
import type { RuntimeOriginalExecutionRef } from "./runtime-authorization.js";

const maximumBytes = 65_536;
const maximumTools = 32;
const maximumPages = 8;
const metadataId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface StandardMcpToolContract {
	readonly name: string;
	/** Whole MCP result schemas from the deployment-approved service contract. */
	readonly succeededResultSchema: Record<string, unknown>;
	readonly failedResultSchema?: Record<string, unknown>;
}

export interface StandardMcpInput extends RuntimeOriginalEvidenceBinding {
	readonly schemaVersion: 1;
	readonly serviceRef: string;
	readonly consumerId: string;
	readonly instanceRef: string;
	readonly issuer: string;
	readonly resource: string;
	readonly audience: string;
	readonly configFingerprint: string;
	readonly source: { readonly ref: string; readonly revision: string };
	readonly credentialRef: string;
	readonly credentialRevision: string;
	readonly expiresAt: number;
	readonly token: string;
	readonly contract: {
		readonly ref: string;
		readonly revision: string;
		readonly serverInfo: { readonly name: string; readonly version: string };
		readonly tools: readonly StandardMcpToolContract[];
	};
}

export type StandardMcpInstallationMetadata = Omit<
	StandardMcpInput,
	"scope" | "token"
> & { readonly agentId: string };

export interface StandardMcpClientOptions {
	/** The local Host producer output; never a transport assertion. */
	readonly target: ApprovedConnectionConsumerTargetV1;
	/** Host owns process protection, original authority and the protected SecretRef. */
	readonly resolveInput: (
		reference: RuntimeOriginalExecutionRef,
		signal: AbortSignal,
	) => Promise<unknown>;
	/** Trusted transport dependency; never supplied by commands or native frames. */
	readonly fetch?: FetchLike;
}

export interface StandardMcpOperation {
	/** Return a synchronous guard to run after all installation-read awaits. */
	assertCurrent(): Promise<() => void>;
	/** Close original model/tool admission synchronously, before queue release. */
	block(): void;
	/** Own result persistence and the original ACK before another MCP action. */
	confirm(result: StandardMcpResult): Promise<void>;
	/** Persist RPC identity in the original intent before any dispatch. */
	prepare(request: {
		rpcRequestId: string | number;
		requestDigest: string;
	}): Promise<void>;
	started(request: {
		rpcRequestId: string | number;
		requestDigest: string;
		startedAt: string;
	}): Promise<void>;
}

export type StandardMcpResult = {
	phase: "completed" | "failed" | "unknown";
	contentItems: { type: "inputText"; text: string }[];
	/** MCP status is distinct from independently verified Connection effects. */
	success: boolean;
};

function unavailable(): never {
	throw new RuntimeHostError(
		"CONNECTION_STANDARD_CLIENT_UNAVAILABLE",
		"Standard Connection client is unavailable",
		503,
		false,
	);
}

function record(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function keys(value: Record<string, unknown>, allowed: string[]) {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function boundedJson(value: unknown, limit = maximumBytes) {
	try {
		const json = JSON.stringify(value);
		if (typeof json !== "string" || Buffer.byteLength(json) > limit)
			unavailable();
		return json;
	} catch {
		return unavailable();
	}
}

/** Index/hash only public schema and operation metadata, never credential input. */
export function standardMcpDigest(value: unknown) {
	return createHash("sha256").update(boundedJson(value)).digest("hex");
}

function schemaValidator(schema: unknown): ValidateFunction {
	if (!record(schema) || !Object.keys(schema).length) unavailable();
	boundedJson(schema, 32_768);
	let nodes = 0;
	const inspect = (value: unknown, depth: number) => {
		if (++nodes > 1024 || depth > 24) unavailable();
		if (Array.isArray(value)) {
			for (const child of value) inspect(child, depth + 1);
		} else if (record(value)) {
			for (const [key, child] of Object.entries(value)) {
				if (
					(key === "$ref" &&
						(typeof child !== "string" || !child.startsWith("#"))) ||
					key === "$dynamicRef" ||
					key === "$recursiveRef"
				)
					unavailable();
				inspect(child, depth + 1);
			}
		}
	};
	inspect(schema, 0);
	try {
		return new Ajv({
			strict: false,
			logger: false,
			validateFormats: false,
		}).compile(schema);
	} catch {
		return unavailable();
	}
}

/** Installation fields only; no fabricated original execution scope. */
export function validateStandardMcpInstallationMetadata(
	value: unknown,
	target: ApprovedConnectionConsumerTargetV1,
): StandardMcpInstallationMetadata {
	if (
		!record(value) ||
		!keys(value, [
			"schemaVersion",
			"principal",
			"agentId",
			"serviceRef",
			"consumerId",
			"instanceRef",
			"issuer",
			"resource",
			"audience",
			"configFingerprint",
			"source",
			"credentialRef",
			"credentialRevision",
			"expiresAt",
			"contract",
		]) ||
		value.schemaVersion !== 1 ||
		!RuntimePrincipalV1Schema.safeParse(value.principal).success ||
		typeof value.agentId !== "string" ||
		value.consumerId !== target.profile.consumerId ||
		value.resource !== target.url ||
		value.audience !== target.profile.audience ||
		value.configFingerprint !== target.configFingerprint ||
		!isDeepStrictEqual(value.source, target.source) ||
		typeof value.expiresAt !== "number" ||
		!Number.isSafeInteger(value.expiresAt) ||
		value.expiresAt <= Date.now()
	)
		unavailable();
	for (const field of [
		"serviceRef",
		"instanceRef",
		"credentialRef",
		"credentialRevision",
	])
		if (
			typeof value[field] !== "string" ||
			!metadataId.test(value[field] as string)
		)
			unavailable();
	try {
		if (
			typeof value.issuer !== "string" ||
			(value.issuer !== target.profile.publicOrigin &&
				value.issuer !== `${target.profile.publicOrigin}/`)
		)
			unavailable();
	} catch {
		unavailable();
	}
	const contract = value.contract;
	if (
		!record(contract) ||
		!keys(contract, ["ref", "revision", "serverInfo", "tools"]) ||
		typeof contract.ref !== "string" ||
		!metadataId.test(contract.ref) ||
		typeof contract.revision !== "string" ||
		!metadataId.test(contract.revision) ||
		!record(contract.serverInfo) ||
		!keys(contract.serverInfo, ["name", "version"]) ||
		typeof contract.serverInfo.name !== "string" ||
		typeof contract.serverInfo.version !== "string" ||
		!metadataId.test(contract.serverInfo.name) ||
		!metadataId.test(contract.serverInfo.version) ||
		!Array.isArray(contract.tools) ||
		contract.tools.length < 1 ||
		contract.tools.length > maximumTools
	)
		unavailable();
	const names = new Set<string>();
	for (const policy of contract.tools) {
		if (
			!record(policy) ||
			!keys(policy, ["name", "succeededResultSchema", "failedResultSchema"]) ||
			typeof policy.name !== "string" ||
			!metadataId.test(policy.name) ||
			names.has(policy.name)
		)
			unavailable();
		names.add(policy.name);
		schemaValidator(policy.succeededResultSchema);
		if (policy.failedResultSchema !== undefined)
			schemaValidator(policy.failedResultSchema);
	}
	boundedJson(contract);
	return structuredClone(value) as unknown as StandardMcpInstallationMetadata;
}

export function validateStandardMcpMetadata(
	value: unknown,
	reference: RuntimeOriginalExecutionRef,
	target: ApprovedConnectionConsumerTargetV1,
): Omit<StandardMcpInput, "token"> {
	if (
		!record(value) ||
		"agentId" in value ||
		!isDeepStrictEqual(value.scope, {
			agentId: reference.agentId,
			conversationId: reference.conversationId,
			sessionGeneration: reference.sessionGeneration,
			executionId: reference.executionId,
		})
	)
		unavailable();
	const { scope, ...installation } = value;
	const { agentId: _agentId, ...metadata } =
		validateStandardMcpInstallationMetadata(
			{ ...installation, agentId: reference.agentId },
			target,
		);
	return { ...metadata, scope: structuredClone(scope) } as Omit<
		StandardMcpInput,
		"token"
	>;
}

export function validateStandardMcpToken(value: unknown): string {
	if (typeof value !== "string" || !/^[\x21-\x7e]{16,4096}$/.test(value))
		unavailable();
	return value;
}

export function validateStandardMcpInput(
	value: unknown,
	reference: RuntimeOriginalExecutionRef,
	target: ApprovedConnectionConsumerTargetV1,
): StandardMcpInput {
	if (!record(value)) unavailable();
	const { token, ...metadata } = value;
	return {
		...validateStandardMcpMetadata(metadata, reference, target),
		token: validateStandardMcpToken(token),
	};
}

function containsCredential(value: unknown, token: string) {
	boundedJson(value);
	const matcher = createCredentialMatcher([
		token,
		encodeURIComponent(token),
		Buffer.from(token).toString("base64"),
	]);
	let state = 0;
	const inspect = (item: unknown): boolean => {
		if (typeof item === "string") {
			const next = matcher.advance(state, item);
			state = next.state;
			return next.matched;
		}
		if (Array.isArray(item)) return item.some(inspect);
		return (
			record(item) &&
			Object.entries(item).some(
				([key, child]) => inspect(key) || inspect(child),
			)
		);
	};
	return inspect(value);
}

type InstalledTool = {
	name: string;
	alias: string;
	definition: {
		type: "function";
		name: string;
		description: string;
		inputSchema: Record<string, unknown>;
	};
	arguments: ValidateFunction;
	succeeded: ValidateFunction;
	failed?: ValidateFunction;
};

/** One original Execution's standard session; no native token or OAuth fallback. */
export class StandardMcpClient {
	readonly #client = new Client({ name: "agent-infra-runtime", version: "1" });
	readonly #abort = new AbortController();
	#input: StandardMcpInput;
	readonly #tools = new Map<string, InstalledTool>();
	#closed = false;
	#queue: Promise<void> = Promise.resolve();
	#active:
		| {
				name: string;
				arguments: Record<string, unknown>;
				operation: StandardMcpOperation;
				sends: number;
		  }
		| undefined;
	#discoveryRequests = 0;
	private constructor(
		private readonly options: StandardMcpClientOptions,
		readonly reference: RuntimeOriginalExecutionRef,
		input: StandardMcpInput,
	) {
		this.#input = input;
		// The SDK otherwise reports transport errors with arbitrary remote text.
		this.#client.onerror = () => {};
	}

	static async open(
		options: StandardMcpClientOptions,
		reference: RuntimeOriginalExecutionRef,
		signal: AbortSignal,
	) {
		signal.throwIfAborted();
		const original = structuredClone(reference);
		const target = structuredClone(options.target);
		if (
			target.status !== "available" ||
			target.url !== target.profile.publicOrigin + target.profile.mcpPath
		)
			unavailable();
		const input = validateStandardMcpInput(
			await options.resolveInput(original, signal),
			original,
			target,
		);
		signal.throwIfAborted();
		const instance = new StandardMcpClient(
			{ ...options, target },
			original,
			input,
		);
		try {
			if (containsCredential(input.contract, input.token)) unavailable();
			const transport = new StreamableHTTPClientTransport(new URL(target.url), {
				fetch: (url, init) => instance.fetch(url, init),
				reconnectionOptions: {
					maxReconnectionDelay: 1,
					initialReconnectionDelay: 1,
					reconnectionDelayGrowFactor: 1,
					maxRetries: 0,
				},
			});
			await instance.#client.connect(transport, { signal, timeout: 10_000 });
			await instance.assertCurrent(signal);
			const peer = instance.#client.getServerVersion();
			if (
				peer?.name !== input.contract.serverInfo.name ||
				peer.version !== input.contract.serverInfo.version
			)
				unavailable();
			const discovered = new Map<string, Tool>();
			let cursor: string | undefined;
			for (let page = 0; page < maximumPages; page++) {
				const listed = await instance.#client.listTools(
					cursor ? { cursor } : undefined,
					{ signal, timeout: 10_000 },
				);
				await instance.assertCurrent(signal);
				boundedJson(listed);
				for (const tool of listed.tools) {
					if (discovered.has(tool.name) || discovered.size >= maximumTools)
						unavailable();
					discovered.set(tool.name, tool);
				}
				cursor = listed.nextCursor;
				if (!cursor) break;
				if (page === maximumPages - 1) unavailable();
			}
			for (const policy of input.contract.tools) {
				const tool = discovered.get(policy.name);
				if (!tool || containsCredential(tool, input.token)) unavailable();
				const alias = `mcp_${standardMcpDigest(tool.name).slice(0, 32)}`;
				const definition = {
					type: "function" as const,
					name: alias,
					description: `${tool.name}: ${tool.description ?? "Connection tool"}`,
					inputSchema: structuredClone(tool.inputSchema),
				};
				boundedJson(definition);
				instance.#tools.set(alias, {
					name: tool.name,
					alias,
					definition,
					arguments: schemaValidator(tool.inputSchema),
					succeeded: schemaValidator(policy.succeededResultSchema),
					...(policy.failedResultSchema
						? { failed: schemaValidator(policy.failedResultSchema) }
						: {}),
				});
			}
			return instance;
		} catch {
			await instance.close();
			return unavailable();
		}
	}

	get serviceRef() {
		return this.#input.serviceRef;
	}
	get toolDefinitions() {
		return [
			{
				type: "namespace" as const,
				name: "connection",
				description: "Approved Connection tools",
				tools: [...this.#tools.values()].map((tool) =>
					structuredClone(tool.definition),
				),
			},
		];
	}
	get fingerprint() {
		return standardMcpDigest([this.toolDefinitions, this.#input.contract]);
	}
	toolName(alias: string) {
		return this.#tools.get(alias)?.name;
	}
	validateArguments(alias: string, value: unknown) {
		const tool = this.#tools.get(alias);
		return (
			!!tool &&
			record(value) &&
			Buffer.byteLength(boundedJson(value)) <= 32_768 &&
			!containsCredential(value, this.#input.token) &&
			tool.arguments(value)
		);
	}

	async assertCurrent(signal: AbortSignal = this.#abort.signal) {
		if (this.#closed || this.#abort.signal.aborted || signal.aborted)
			unavailable();
		const fresh = validateStandardMcpInput(
			await this.options.resolveInput(this.reference, signal),
			this.reference,
			this.options.target,
		);
		const { token, ...before } = this.#input;
		const { token: current, ...after } = fresh;
		const a = Buffer.from(token);
		const b = Buffer.from(current);
		if (
			!isDeepStrictEqual(before, after) ||
			a.length !== b.length ||
			!timingSafeEqual(a, b) ||
			this.#closed ||
			signal.aborted
		)
			unavailable();
	}

	async call(
		alias: string,
		arguments_: Record<string, unknown>,
		operation: StandardMcpOperation,
		signal: AbortSignal,
	): Promise<StandardMcpResult> {
		const previous = this.#queue;
		const release = Promise.withResolvers<void>();
		this.#queue = previous.catch(() => {}).then(() => release.promise);
		await previous.catch(() => {});
		try {
			const result = await this.performCall(
				alias,
				arguments_,
				operation,
				signal,
			);
			if (result.phase === "unknown") this.block(operation);
			try {
				await operation.confirm(result);
			} catch {
				this.block(operation);
				return unavailable();
			}
			return result;
		} finally {
			release.resolve();
		}
	}

	private block(operation: StandardMcpOperation) {
		this.#closed = true;
		this.#abort.abort();
		this.#input = { ...this.#input, token: "" };
		operation.block();
		void this.#client.close().catch(() => {});
	}

	private unknown(operation: StandardMcpOperation): StandardMcpResult {
		this.block(operation);
		return { phase: "unknown", contentItems: [], success: false };
	}

	private async performCall(
		alias: string,
		arguments_: Record<string, unknown>,
		operation: StandardMcpOperation,
		signal: AbortSignal,
	): Promise<StandardMcpResult> {
		const tool = this.#tools.get(alias);
		try {
			if (!tool || !this.validateArguments(alias, arguments_)) unavailable();
			await this.assertCurrent(signal);
			(await operation.assertCurrent())();
			this.#active = {
				name: tool.name,
				arguments: structuredClone(arguments_),
				operation,
				sends: 0,
			};
			let result: CallToolResult;
			try {
				result = (await this.#client.callTool(
					{ name: tool.name, arguments: this.#active.arguments },
					undefined,
					{
						signal: AbortSignal.any([signal, this.#abort.signal]),
						timeout: 30_000,
					},
				)) as CallToolResult;
			} catch {
				return this.#active.sends
					? this.unknown(operation)
					: { phase: "failed", contentItems: [], success: false };
			}
			if (
				this.#active.sends !== 1 ||
				containsCredential(result, this.#input.token)
			)
				return this.unknown(operation);
			boundedJson(result);
			const completed = result.isError !== true && tool.succeeded(result);
			const failed = !completed && tool.failed?.(result) === true;
			if (!completed && !failed) return this.unknown(operation);
			const text = result.content
				.filter((item) => item.type === "text")
				.map((item) => item.text);
			if (result.structuredContent !== undefined)
				text.push(boundedJson(result.structuredContent));
			const projected = [
				{
					type: "inputText" as const,
					text: text.join("\n") || "Connection returned no text",
				},
			];
			boundedJson(projected);
			if (containsCredential(projected, this.#input.token))
				return this.unknown(operation);
			return {
				phase: completed ? "completed" : "failed",
				contentItems: projected,
				success: completed,
			};
		} catch {
			return this.#active?.sends
				? this.unknown(operation)
				: { phase: "failed", contentItems: [], success: false };
		} finally {
			this.#active = undefined;
		}
	}

	async close() {
		this.#closed = true;
		this.#abort.abort();
		// Drop the reachable secret reference. This is not a JS memory erasure
		// claim; operating-system protection remains independently required.
		this.#input = { ...this.#input, token: "" };
		await this.#client.close().catch(() => {});
	}

	private async fetch(
		url: Parameters<FetchLike>[0],
		init?: Parameters<FetchLike>[1],
	): Promise<Response> {
		if (this.#closed) unavailable();
		const actual = new URL(url);
		if (
			actual.href !== new URL(this.options.target.url).href ||
			actual.protocol !== "https:"
		)
			unavailable();
		await this.assertCurrent();
		const method = init?.method ?? "GET";
		let recordStarted: (() => Promise<void>) | undefined;
		if (method === "POST") {
			if (typeof init?.body !== "string") unavailable();
			const parsed: unknown = JSON.parse(init.body);
			if (!record(parsed)) unavailable();
			if (parsed.method === "tools/call") {
				const active = this.#active;
				if (
					active?.sends !== 0 ||
					!record(parsed.params) ||
					parsed.params.name !== active.name ||
					!isDeepStrictEqual(parsed.params.arguments, active.arguments) ||
					(typeof parsed.id !== "string" && typeof parsed.id !== "number")
				)
					unavailable();
				const revalidate = await active.operation.assertCurrent();
				await this.assertCurrent();
				const guarded: unknown = revalidate();
				if (
					guarded !== undefined ||
					this.#closed ||
					this.#input.expiresAt <= Date.now()
				)
					unavailable();
				active.sends++;
				// Reserve the attempt, but do not dispatch before its RPC identity
				// and digest are durable. A failed write retains the unknown hold.
				const request = {
					rpcRequestId: parsed.id as string | number,
					requestDigest: standardMcpDigest(parsed.params),
				};
				await active.operation.prepare(request);
				const finalRevalidate = await active.operation.assertCurrent();
				await this.assertCurrent();
				const finalGuarded: unknown = finalRevalidate();
				if (
					finalGuarded !== undefined ||
					this.#closed ||
					this.#input.expiresAt <= Date.now()
				)
					unavailable();
				recordStarted = () =>
					active.operation.started({
						...request,
						startedAt: new Date().toISOString(),
					});
			} else if (this.#active?.sends || ++this.#discoveryRequests > 16)
				unavailable();
		} else if (method !== "GET") unavailable();
		const headers = new Headers(init?.headers);
		headers.set("authorization", `Bearer ${this.#input.token}`);
		const fetch = this.options.fetch ?? globalThis.fetch;
		const pending = fetch(url, {
			...init,
			headers,
			redirect: "manual",
			signal: AbortSignal.any([
				this.#abort.signal,
				...(init?.signal ? [init.signal] : []),
			]),
		});
		void pending.catch(() => {});
		await recordStarted?.();
		const response = await pending;
		if (response.status >= 300 && response.status < 400) unavailable();
		if (!response.body) return response;
		// Bound JSON and SSE responses while keeping the SDK's standard transport.
		const reader = response.body.getReader();
		let length = 0;
		return new Response(
			new ReadableStream({
				async pull(controller) {
					const next = await reader.read();
					if (next.done) {
						controller.close();
						return;
					}
					length += next.value.byteLength;
					if (length > maximumBytes) {
						await reader.cancel();
						controller.error(new Error("MCP response unavailable"));
						return;
					}
					controller.enqueue(next.value);
				},
				cancel: () => reader.cancel(),
			}),
			{
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			},
		);
	}
}
