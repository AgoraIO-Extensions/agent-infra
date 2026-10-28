import { randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { forwardClaudeMessages } from "./claude-messages-stream.js";
import { validateModelAccess } from "./codex-app-server-bridge.js";

export type RuntimeMessagesTransportStage =
	| "request"
	| "admission"
	| "credential"
	| "upstream_http"
	| "upstream_content_type"
	| "stream_validation"
	| "transport"
	| "abort";

export interface RuntimeMessagesTransportDiagnostic {
	readonly stage: RuntimeMessagesTransportStage;
	readonly sent: boolean;
	readonly durationMs: number;
	readonly statusCode?: number;
	readonly statusClass?: "1xx" | "2xx" | "3xx" | "4xx" | "5xx";
	readonly usage?: {
		readonly inputTokens?: number;
		readonly outputTokens?: number;
		readonly cachedInputTokens?: number;
	};
}

export type RuntimeMessagesPurpose =
	| "main"
	| "web-fetch"
	| "web-search"
	| "count-tokens";
export interface RuntimeMessagesRequest {
	readonly resolveCredential?: () => Promise<string>;
	readonly revalidate?: () => void;
	readonly receipt?: RuntimeMessagesTransportOptions["receipt"];
}

export interface RuntimeMessagesTransportOptions {
	readonly client?: "claude" | "opencode" | "pi";
	readonly endpoint: string;
	readonly credential?: string;
	/** V4 execution-key delivery. Resolved immediately before each upstream request. */
	readonly resolveCredential?: () => Promise<string>;
	readonly authentication: "api-key" | "bearer";
	readonly model: string;
	readonly effort: string;
	readonly admit: () => Promise<void>;
	readonly fetch?: typeof fetch;
	/** Trusted Driver admission per actual HTTP request, never a native-provided identity. */
	readonly openRequest?: (
		purpose: RuntimeMessagesPurpose,
	) => Promise<RuntimeMessagesRequest>;
	readonly receipt?: (
		state: "sent" | "completed" | "failed" | "unknown",
		endTurn: boolean,
		diagnostic?: RuntimeMessagesTransportDiagnostic,
	) => Promise<void>;
}

const allowedBetas = new Set(
	"structured-outputs-2025-11-13,fine-grained-tool-streaming-2025-05-14,claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,effort-2025-11-24,fallback-credit-2026-06-01".split(
		",",
	),
);

const failureBody = JSON.stringify({
	type: "error",
	error: {
		type: "invalid_request_error",
		message: "Runtime model request failed",
	},
});
function reject(
	response: ServerResponse,
	status = 400,
	capability?: "web-search" | "web-fetch",
) {
	const body = capability
		? JSON.stringify({
				type: "error",
				error: {
					type: "invalid_request_error",
					message:
						capability === "web-search"
							? "Native WebSearch is unavailable from the approved model endpoint."
							: "Native WebFetch content processing is unavailable from the approved model endpoint.",
				},
			})
		: failureBody;
	if (!response.headersSent) {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(body);
	} else response.end(`event: error\ndata: ${body}\n\n`);
}

/** One Query, one fixed option. No discovery, routing, retries, or user-supplied upstream headers. */
export async function openRuntimeMessagesTransport(
	options: RuntimeMessagesTransportOptions,
) {
	const access =
		options.credential === undefined
			? undefined
			: validateModelAccess({
					endpoint: options.endpoint,
					credential: options.credential,
				});
	if (
		(!access && !options.resolveCredential && !options.openRequest) ||
		!["api-key", "bearer"].includes(options.authentication) ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.model) ||
		!["low", "medium", "high", "xhigh", "max"].includes(options.effort)
	)
		throw new Error("RUNTIME_CONFIGURATION_INVALID");
	const token = randomBytes(32).toString("hex");
	const controllers = new Set<AbortController>();
	const pending = new Set<Promise<void>>();
	let closed = false;
	let admitted = false;
	let active = 0;
	let failure: "failed" | "unknown" | undefined;
	const seal = (outcome: "failed" | "unknown") => {
		if (failure !== "unknown") failure = outcome;
	};
	const server = createServer((request, response) => {
		const operation = (async () => {
			if (
				closed ||
				failure ||
				request.method !== "POST" ||
				(options.client === "opencode" || options.client === "pi"
					? request.headers["x-api-key"] !== token
					: request.headers.authorization !== `Bearer ${token}`) ||
				![
					"/v1/messages",
					"/v1/messages?beta=true",
					"/v1/messages/count_tokens",
					"/v1/messages/count_tokens?beta=true",
				].includes(request.url ?? "")
			) {
				request.resume();
				reject(response);
				return;
			}
			if (active >= (options.openRequest ? 4 : 1)) {
				request.resume();
				reject(response);
				return;
			}
			active++;
			const controller = new AbortController();
			controllers.add(controller);
			response.once("close", () => {
				if (!response.writableFinished) controller.abort();
			});
			let sent = false;
			let stage: RuntimeMessagesTransportStage = "request";
			let statusCode: number | undefined;
			let requestContext: RuntimeMessagesRequest | undefined;
			let usage: RuntimeMessagesTransportDiagnostic["usage"];
			const assertOpen = () => {
				if (closed || failure || controller.signal.aborted)
					throw new Error("RUNTIME_MODEL_QUERY_SEALED");
			};
			const receipt: NonNullable<RuntimeMessagesTransportOptions["receipt"]> = (
				...args
			) =>
				(requestContext?.receipt ?? options.receipt)?.(...args) ??
				Promise.resolve();
			const startedAt = Date.now();
			const diagnostic = (): RuntimeMessagesTransportDiagnostic => {
				const safeStatusCode =
					statusCode !== undefined && statusCode >= 100 && statusCode <= 599
						? statusCode
						: undefined;
				return {
					stage,
					sent,
					durationMs: Math.max(0, Date.now() - startedAt),
					...(usage ? { usage } : {}),
					...(safeStatusCode === undefined
						? {}
						: {
								statusCode: safeStatusCode,
								statusClass: `${Math.floor(safeStatusCode / 100)}xx` as
									| "1xx"
									| "2xx"
									| "3xx"
									| "4xx"
									| "5xx",
							}),
				};
			};
			try {
				const chunks: Buffer[] = [];
				let size = 0;
				for await (const chunk of request) {
					size += chunk.length;
					if (size > 16_777_216) throw new Error();
					chunks.push(chunk);
				}
				const body = JSON.parse(
					new TextDecoder("utf-8", { fatal: true }).decode(
						Buffer.concat(chunks),
					),
				);
				assertOpen();
				const counting = request.url?.includes("/count_tokens");
				const auxiliary =
					options.client !== "opencode" &&
					options.client !== "pi" &&
					options.openRequest &&
					body.thinking?.type === "disabled";
				const purpose: RuntimeMessagesPurpose = counting
					? "count-tokens"
					: !auxiliary
						? "main"
						: Array.isArray(body.tools) &&
								body.tools.length === 0 &&
								body.tool_choice === undefined
							? "web-fetch"
							: "web-search";
				if (
					purpose !== "web-search" &&
					Array.isArray(body.tools) &&
					body.tools.some(
						(tool: { type?: unknown }) =>
							typeof tool?.type === "string" &&
							tool.type.startsWith("web_search"),
					)
				)
					throw new Error();
				if (
					purpose === "web-search" &&
					!(
						Array.isArray(body.tools) &&
						body.tools.length === 1 &&
						body.tools[0]?.type === "web_search_20250305" &&
						body.tools[0]?.name === "web_search" &&
						Object.keys(body.tools[0]).every((key) =>
							[
								"name",
								"type",
								"max_uses",
								"allowed_domains",
								"blocked_domains",
								"user_location",
							].includes(key),
						) &&
						body.tool_choice?.type === "tool" &&
						body.tool_choice?.name === "web_search"
					)
				)
					throw new Error();
				if (
					closed ||
					controller.signal.aborted ||
					body.model !== options.model ||
					!Array.isArray(body.messages) ||
					(!counting &&
						(body.stream !== true ||
							body.output_config?.effort !== options.effort ||
							body.thinking?.type !== (auxiliary ? "disabled" : "adaptive")))
				)
					throw new Error();
				const beta = request.headers["anthropic-beta"];
				const requestedBetas = typeof beta === "string" ? beta.split(",") : [];
				if (
					(beta !== undefined && typeof beta !== "string") ||
					requestedBetas.some((value) => !allowedBetas.has(value)) ||
					new Set(requestedBetas).size !== requestedBetas.length
				)
					throw new Error();
				if (!admitted || options.client === "pi") {
					stage = "admission";
					await options.admit();
					assertOpen();
					admitted = true;
				}
				assertOpen();
				requestContext = await options.openRequest?.(purpose);
				assertOpen();
				stage = "credential";
				const resolveCredential =
					requestContext?.resolveCredential ?? options.resolveCredential;
				const credential = resolveCredential
					? await resolveCredential()
					: options.credential;
				assertOpen();
				const requestAccess = validateModelAccess({
					endpoint: options.endpoint,
					credential,
				});
				if (!requestAccess) throw new Error();
				const headers: Record<string, string> = {
					"content-type": "application/json",
					"anthropic-version": "2023-06-01",
					"user-agent":
						options.client === "pi"
							? "agent-infra-pi/0.99.0"
							: options.client === "opencode"
								? "agent-infra-opencode/1.19.0"
								: "claude-cli/2.1.246 (external, sdk-ts, agent-sdk/0.3.246)",
					"x-app": "cli",
				};
				if (typeof beta === "string") headers["anthropic-beta"] = beta;
				if (options.authentication === "api-key")
					headers["x-api-key"] = requestAccess.credential;
				else headers.authorization = `Bearer ${requestAccess.credential}`;
				stage = "upstream_http";
				if (!counting || options.openRequest)
					await receipt("sent", false, diagnostic());
				assertOpen();
				requestContext?.revalidate?.();
				assertOpen();
				sent = true;
				const upstream = await (options.fetch ?? fetch)(
					`${requestAccess.endpoint.replace(/\/$/, "")}${request.url}`,
					{
						method: "POST",
						headers,
						body: JSON.stringify(body),
						redirect: "error",
						signal: controller.signal,
					},
				);

				if (!upstream.ok) {
					void upstream.body?.cancel().catch(() => {});
					statusCode = upstream.status;
					const outcome = upstream.status >= 500 ? "unknown" : "failed";
					// A known auxiliary rejection is an ordinary tool failure. An
					// uncertain send still seals the entire Query against replay.
					if (
						![400, 404, 422].includes(upstream.status) ||
						purpose === "main" ||
						purpose === "count-tokens"
					)
						seal(outcome);
					await receipt(outcome, false, diagnostic());
					reject(
						response,
						400,
						purpose === "web-search" || purpose === "web-fetch"
							? purpose
							: undefined,
					);
					return;
				}
				if (counting) {
					stage = "stream_validation";
					if (!upstream.body) throw new Error();
					const chunks: Uint8Array[] = [];
					let length = 0;
					for await (const chunk of upstream.body) {
						length += chunk.byteLength;
						if (length > 1_048_576) throw new Error();
						chunks.push(chunk);
					}
					const value = JSON.parse(
						new TextDecoder("utf-8", { fatal: true }).decode(
							Buffer.concat(chunks),
						),
					);
					if (
						!value ||
						typeof value !== "object" ||
						Object.keys(value).length !== 1 ||
						!Number.isSafeInteger(value.input_tokens) ||
						value.input_tokens < 0
					)
						throw new Error();
					response.writeHead(200, { "content-type": "application/json" });
					if (options.openRequest)
						await receipt("completed", false, diagnostic());
					response.end(JSON.stringify({ input_tokens: value.input_tokens }));
					return;
				}
				if (!upstream.body) {
					stage = "upstream_content_type";
					throw new Error();
				}
				if (
					!/^text\/event-stream(?:;|$)/i.test(
						upstream.headers.get("content-type") ?? "",
					)
				) {
					stage = "upstream_content_type";
					void upstream.body?.cancel().catch(() => {});
					throw new Error();
				}
				stage = "stream_validation";
				await forwardClaudeMessages(
					upstream.body,
					response,
					options.model,
					[requestAccess.credential, requestAccess.endpoint],
					controller.signal,
					async (reason, receivedUsage) => {
						usage = receivedUsage;
						await receipt("completed", reason === "end_turn", diagnostic());
					},
					purpose === "web-search",
				);
			} catch {
				if (controller.signal.aborted) stage = "abort";
				else if (sent && stage === "upstream_http") stage = "transport";
				controller.abort();
				const outcome = sent ? "unknown" : "failed";
				seal(outcome);
				try {
					await receipt(outcome, false, diagnostic());
				} catch {
					seal("unknown");
				}
				reject(response);
			} finally {
				active--;
				controllers.delete(controller);
			}
		})();
		pending.add(operation);
		void operation.then(
			() => pending.delete(operation),
			() => {
				failure = "unknown";
				response.destroy();
				pending.delete(operation);
			},
		);
	});
	server.requestTimeout = 30_000;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	server.unref();
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("RUNTIME_CONFIGURATION_INVALID");
	return {
		modelAccess: {
			endpoint: `http://127.0.0.1:${address.port}`,
			credential: token,
		},
		/** Start a new Execution on a reused native session. */
		beginTurn() {
			if (active !== 0 || closed) throw new Error("RUNTIME_MODEL_QUERY_ACTIVE");
			admitted = false;
			failure = undefined;
		},
		failure: () => failure,
		async close() {
			if (closed) return;
			closed = true;
			for (const controller of controllers) controller.abort();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await Promise.allSettled(pending);
		},
	};
}
