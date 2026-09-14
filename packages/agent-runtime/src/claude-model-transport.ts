import { randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { forwardClaudeMessages } from "./claude-messages-stream.js";
import { validateModelAccess } from "./codex-app-server-bridge.js";

export interface ClaudeModelTransportOptions {
	readonly endpoint: string;
	readonly credential: string;
	readonly authentication: "api-key" | "bearer";
	readonly model: string;
	readonly effort: string;
	readonly admit: () => Promise<void>;
	readonly fetch?: typeof fetch;
	readonly receipt?: (
		state: "sent" | "completed" | "failed" | "unknown",
		endTurn?: boolean,
	) => Promise<void>;
}

const allowedBetas = new Set(
	"claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,effort-2025-11-24,fallback-credit-2026-06-01".split(
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
function reject(response: ServerResponse, status = 400) {
	if (!response.headersSent) {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(failureBody);
	} else response.end(`event: error\ndata: ${failureBody}\n\n`);
}

/** One Query, one fixed option. No discovery, routing, retries, or user-supplied upstream headers. */
export async function openClaudeModelTransport(
	options: ClaudeModelTransportOptions,
) {
	const access = validateModelAccess({
		endpoint: options.endpoint,
		credential: options.credential,
	});
	if (
		!access ||
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
	let active = false;
	let failure: "failed" | "unknown" | undefined;
	const server = createServer((request, response) => {
		const operation = (async () => {
			if (
				closed ||
				failure ||
				request.method !== "POST" ||
				request.headers.authorization !== `Bearer ${token}` ||
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
			if (active) {
				request.resume();
				reject(response);
				return;
			}
			active = true;
			const controller = new AbortController();
			controllers.add(controller);
			response.once("close", () => {
				if (!response.writableFinished) controller.abort();
			});
			let sent = false;
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
				const counting = request.url?.includes("/count_tokens");
				if (
					closed ||
					controller.signal.aborted ||
					body.model !== options.model ||
					!Array.isArray(body.messages) ||
					(!counting &&
						(body.stream !== true ||
							body.output_config?.effort !== options.effort ||
							body.thinking?.type !== "adaptive"))
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
				if (!admitted) {
					await options.admit();
					admitted = true;
				}
				if (closed || controller.signal.aborted) throw new Error();
				const headers: Record<string, string> = {
					"content-type": "application/json",
					"anthropic-version": "2023-06-01",
					"user-agent":
						"claude-cli/2.1.246 (external, sdk-ts, agent-sdk/0.3.246)",
					"x-app": "cli",
				};
				if (typeof beta === "string") headers["anthropic-beta"] = beta;
				if (options.authentication === "api-key")
					headers["x-api-key"] = access.credential;
				else headers.authorization = `Bearer ${access.credential}`;
				if (!counting) await options.receipt?.("sent");
				sent = true;
				const upstream = await (options.fetch ?? fetch)(
					`${access.endpoint.replace(/\/$/, "")}${request.url}`,
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
					failure = upstream.status >= 500 ? "unknown" : "failed";
					await options.receipt?.(failure);
					reject(response);
					return;
				}
				if (counting) {
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
					response.end(JSON.stringify({ input_tokens: value.input_tokens }));
					return;
				}
				if (
					!upstream.body ||
					!/^text\/event-stream(?:;|$)/i.test(
						upstream.headers.get("content-type") ?? "",
					)
				) {
					void upstream.body?.cancel().catch(() => {});
					throw new Error();
				}
				await forwardClaudeMessages(
					upstream.body,
					response,
					options.model,
					[access.credential, access.endpoint],
					controller.signal,
					async (reason) => {
						await options.receipt?.("completed", reason === "end_turn");
					},
				);
			} catch {
				controller.abort();
				if (!closed && !failure) failure = sent ? "unknown" : "failed";
				if (failure) {
					try {
						await options.receipt?.(failure);
					} catch {
						failure = "unknown";
					}
				}
				reject(response);
			} finally {
				active = false;
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
