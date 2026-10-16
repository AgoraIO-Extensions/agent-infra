import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Context, MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import {
	createTraceParent,
	isOperationalFailureStep,
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
	failureStep?: string;
	errorClass?: string;
	sqlState?: string;
}>();

export function currentRequestMetadata(): RequestMetadata | undefined {
	const request = requests.getStore();
	return request?.active ? request.metadata : undefined;
}

export function recordHttpFailureContext(input: {
	readonly failureStep: string;
	readonly error?: unknown;
	readonly sqlState?: string;
}): void {
	const request = requests.getStore();
	if (!request?.active || !isOperationalFailureStep(input.failureStep)) return;
	request.failureStep = input.failureStep;
	if (input.sqlState && /^[0-9A-Z]{5}$/.test(input.sqlState))
		request.sqlState = input.sqlState;
	let current = input.error;
	for (
		let depth = 0;
		depth < 4 && current && typeof current === "object";
		depth++
	) {
		const value = current as {
			constructor?: { name?: unknown };
			code?: unknown;
			cause?: unknown;
		};
		const name = value.constructor?.name;
		if (
			request.errorClass === undefined &&
			typeof name === "string" &&
			/^[A-Za-z][A-Za-z0-9_$.-]{0,63}$/.test(name)
		)
			request.errorClass = name;
		if (
			request.sqlState === undefined &&
			typeof value.code === "string" &&
			/^[0-9A-Z]{5}$/.test(value.code)
		)
			request.sqlState = value.code;
		current = value.cause;
	}
}

const protocolCodePattern = /^[A-Z][A-Z0-9_]{2,63}$/;
const maximumProtocolBodyBytes = 4_096;
const protocolBodyDeadlineMs = 100;

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

/**
 * 从克隆的响应里最多读 `maximumProtocolBodyBytes` 字节，超出或出错都当作没有错误码。
 * 读取从不抛出：调用方在限时到达后会放弃等待，这里的读取还会继续收尾，不能产生未处理的拒绝。
 */
async function readBoundedBody(
	reader: ReadableStreamDefaultReader<Uint8Array>,
) {
	try {
		const decoder = new TextDecoder();
		let text = "";
		let bytes = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return text + decoder.decode();
			bytes += value.byteLength;
			if (bytes > maximumProtocolBodyBytes) return undefined;
			text += decoder.decode(value, { stream: true });
		}
	} catch {
		return undefined;
	}
}

/**
 * 只取协议错误响应里的 `code`，且必须是大写下划线的有界标识；正文本身不进入日志。
 * 正文按块读取，超过 4 KiB 或 `protocolBodyDeadlineMs` 内没有读完就放弃，所以无限或停住的
 * JSON 流既不会占用无界内存，也不会拖住这个请求的完成记录和响应。
 */
async function protocolCodeOf(response: Response) {
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		if (!response.headers.get("content-type")?.includes("application/json"))
			return undefined;
		const declared = Number(response.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > maximumProtocolBodyBytes)
			return undefined;
		reader = response.clone().body?.getReader();
		if (reader === undefined) return undefined;
		const text = await Promise.race([
			readBoundedBody(reader),
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), protocolBodyDeadlineMs);
			}),
		]);
		if (text === undefined) return undefined;
		const code = (JSON.parse(text) as { code?: unknown } | null)?.code;
		return typeof code === "string" && protocolCodePattern.test(code)
			? code
			: undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
		// 克隆出来的分支取消后不会影响原响应；这里不等待取消完成（tee 的取消要两个分支都取消才完成）。
		void reader?.cancel().catch(() => undefined);
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
		const request: {
			readonly metadata: RequestMetadata;
			active: boolean;
			failureStep?: string;
			errorClass?: string;
			sqlState?: string;
		} = {
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
						...(request.failureStep === undefined
							? {}
							: { failureStep: request.failureStep }),
						...(request.errorClass === undefined
							? {}
							: { errorClass: request.errorClass }),
						...(request.sqlState === undefined
							? {}
							: { sqlState: request.sqlState }),
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
