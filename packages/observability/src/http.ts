import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Context, MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import {
	createTraceParent,
	type ObservabilitySpan,
	type startObservability,
} from "./index.js";

interface RequestMetadata {
	readonly requestId: string;
	readonly traceId: string;
	/** Internal W3C context; non-enumerable on the returned object. */
	readonly traceParent?: string;
}

const requests = new AsyncLocalStorage<{
	readonly metadata: RequestMetadata;
	active: boolean;
}>();

export function currentRequestMetadata(): RequestMetadata | undefined {
	const request = requests.getStore();
	return request?.active ? request.metadata : undefined;
}

const protocolCodePattern = /^[A-Z][A-Z0-9_]{2,63}$/;
const maximumProtocolBodyBytes = 4_096;
const protocolBodyReadTimeoutMs = 100;

/**
 * 路由模板转成日志里的操作引用：`POST /api/v2/agents/:agentId/lifecycle` 变成
 * `POST.api.v2.agents.:agentId.lifecycle`。只含注册过的路由模板，不含具体 ID 和查询串；
 * 没有匹配到任何路由的请求记为 `unmatched`（#2569）。
 */
function routeOperationRef(method: string, template: string) {
	if (!/^[A-Z]{3,10}$/.test(method)) return undefined;
	const path = template.includes("*")
		? "unmatched"
		: template
				.replace(/^\/+|\/+$/g, "")
				.replace(/\/+/g, ".")
				.replace(/[^A-Za-z0-9._:-]/g, "_");
	const reference = `${method}.${path || "root"}`;
	return reference.length <= 128 ? reference : undefined;
}

/** Reads only a bounded prefix of an error response and never waits indefinitely. */
async function boundedProtocolBody(response: Response) {
	const body = response.clone().body;
	if (!body) return undefined;
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const read = (async () => {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				const bytes = new Uint8Array(total);
				let offset = 0;
				for (const chunk of chunks) {
					bytes.set(chunk, offset);
					offset += chunk.byteLength;
				}
				return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			}
			if (!value) continue;
			total += value.byteLength;
			if (total > maximumProtocolBodyBytes) {
				await reader.cancel().catch(() => undefined);
				return undefined;
			}
			chunks.push(value);
		}
	})();
	try {
		return await Promise.race([
			read,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => {
					resolve(undefined);
				}, protocolBodyReadTimeoutMs);
			}),
		]);
	} catch {
		return undefined;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		let cancelTimer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			reader.cancel().catch(() => undefined),
			new Promise<void>((resolve) => {
				cancelTimer = setTimeout(resolve, protocolBodyReadTimeoutMs);
			}),
		]);
		if (cancelTimer !== undefined) clearTimeout(cancelTimer);
		reader.releaseLock();
	}
}

/** 只取协议错误响应里的 `code`，且必须是大写下划线的有界标识；正文本身不进入日志。 */
async function protocolCodeOf(response: Response) {
	try {
		if (!response.headers.get("content-type")?.includes("application/json"))
			return undefined;
		const declared = Number(response.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > maximumProtocolBodyBytes)
			return undefined;
		const text = await boundedProtocolBody(response);
		if (text === undefined) return undefined;
		const code = (JSON.parse(text) as { code?: unknown } | null)?.code;
		return typeof code === "string" && protocolCodePattern.test(code)
			? code
			: undefined;
	} catch {
		return undefined;
	}
}

async function failureDetails(context: Context, status: number | undefined) {
	const operationRef = routeOperationRef(
		context.req.method,
		routePath(context),
	);
	const protocolCode =
		status === undefined ? undefined : await protocolCodeOf(context.res);
	return {
		...(status === undefined ? {} : { status }),
		...(operationRef === undefined ? {} : { operationRef }),
		...(protocolCode === undefined ? {} : { protocolCode }),
	};
}

/** Measures response-header readiness, not the lifetime of a streaming body. */
export function createHttpObservability(
	telemetry: Pick<ReturnType<typeof startObservability>, "record"> &
		Partial<Pick<ReturnType<typeof startObservability>, "startSpan">>,
): MiddlewareHandler {
	return async (context, next) => {
		let span: ObservabilitySpan | undefined;
		try {
			span = telemetry.startSpan?.("platform.http.server");
		} catch {
			// Trace setup cannot change the existing response or exception.
		}
		const traceParent =
			span?.traceParent ??
			(telemetry.startSpan === undefined ? undefined : createTraceParent());
		const metadata = {
			requestId: randomUUID(),
			traceId: randomUUID(),
		};
		if (traceParent !== undefined)
			Object.defineProperty(metadata, "traceParent", {
				value: traceParent,
				enumerable: false,
				writable: false,
			});
		const request = {
			metadata: Object.freeze(metadata) as RequestMetadata,
			active: true,
		};
		return requests.run(request, async () => {
			const began = performance.now();
			let threw = false;
			try {
				await next();
			} catch (error) {
				threw = true;
				throw error;
			} finally {
				request.active = false;
				try {
					const status = threw ? undefined : context.res.status;
					const outcome =
						threw || (status ?? 0) >= 500
							? "failed"
							: (status ?? 0) >= 400
								? "rejected"
								: "completed";
					// 被拒绝或失败的请求才带上方法与路由模板、状态码和协议错误码（#2569）。
					const failure =
						outcome === "completed"
							? {}
							: await failureDetails(context, status);
					telemetry.record({
						stage: "http",
						outcome,
						durationMs: performance.now() - began,
						...failure,
						...request.metadata,
						...(traceParent === undefined ? {} : { traceParent }),
					});
				} catch {
					// Telemetry cannot change the existing response or exception.
				}
				span?.end();
			}
		});
	};
}
