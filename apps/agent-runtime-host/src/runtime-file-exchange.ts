import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import type {
	RuntimeFileBridgeBindingV1,
	RuntimeFileBridgeFactoryV1,
	RuntimeFileExchangeEvidenceV1,
	RuntimeFileInputV1,
	RuntimeFileResultOptionsV1,
	RuntimeFileResultV1,
} from "@agent-infra/agent-runtime";
import {
	createRuntimeFileBridgeV1,
	RuntimeFileInputRejectedError,
	RuntimeFileResultUnconfirmedError,
} from "@agent-infra/agent-runtime";
import {
	FileAccessResponseV1Schema,
	type FileDescriptorV1,
	FileProjectionV1Schema,
	RuntimeFileExchangeRequestV2Schema,
} from "@agent-infra/contracts/files";
import { runtimeHostService } from "./app.js";

export interface RuntimeFileExchangeOptionsV1 {
	readonly origin: string;
	readonly serviceToken: string;
	readonly timeoutMs?: number;
	readonly fetch?: typeof fetch;
	/** #3289：失败诊断出口，默认写入 stderr；只接收下方的有界字段。 */
	readonly logDiagnostic?: (entry: RuntimeFileExchangeDiagnosticV1) => void;
}

/**
 * FileBridge 交换、读、写失败的稳定诊断（#3289）。只含固定错误码、阶段、有界原因、
 * HTTP 状态与系统错误码；不含凭据、URL、路径、Grant 或文件内容。
 */
export interface RuntimeFileExchangeDiagnosticV1 {
	readonly service: typeof runtimeHostService;
	readonly code: "RUNTIME_FILE_EXCHANGE_UNAVAILABLE";
	/** exchange：换取 File Grant；read/write：数据面读写；complete：结果完成确认。 */
	readonly operation: "exchange" | "read" | "write" | "complete";
	readonly reason:
		| "unreachable"
		| "timeout"
		| "rejected"
		| "invalid_response"
		| "unconfirmed"
		| "failed";
	/** 平台返回的非成功 HTTP 状态：rejected，或完成确认返回 5xx 时的 unconfirmed。 */
	readonly status?: number;
	/** 本模块抛出的稳定错误码，例如 RUNTIME_FILE_INPUT_UNAVAILABLE。 */
	readonly error?: string;
	/** 传输层错误码，例如 UND_ERR_CONNECT_TIMEOUT、ECONNREFUSED。 */
	readonly cause?: string;
}

type RuntimeFileExchangeTrackV1 = {
	operation: RuntimeFileExchangeDiagnosticV1["operation"];
	status?: number;
};

const stableErrorCode = /^RUNTIME_FILE_[A-Z_]{1,64}$/;
const transportErrorCode = /^[A-Z][A-Z0-9_]{1,63}$/;

/** 错误对象只输出固定形状的代码：自身 message 须是本模块的稳定错误码，cause 链只取系统错误码。 */
function runtimeFileExchangeDiagnosticV1(
	track: RuntimeFileExchangeTrackV1,
	error: unknown,
): RuntimeFileExchangeDiagnosticV1 {
	const name = error instanceof Error ? error.name : undefined;
	const message = error instanceof Error ? error.message : undefined;
	let causeCode: unknown;
	// undici 把 UND_ERR_CONNECT_TIMEOUT 等代码放在 cause（可能再嵌套一层）上。
	let current: unknown = error instanceof Error ? error.cause : undefined;
	for (
		let depth = 0;
		depth < 3 && typeof current === "object" && current !== null;
		depth++
	) {
		if ("code" in current) {
			causeCode = current.code;
			break;
		}
		current = (current as { cause?: unknown }).cause;
	}
	const reason: RuntimeFileExchangeDiagnosticV1["reason"] =
		error instanceof RuntimeFileResultUnconfirmedError
			? "unconfirmed"
			: track.status !== undefined
				? "rejected"
				: name === "TimeoutError" || name === "AbortError"
					? "timeout"
					: name === "ZodError" || error instanceof SyntaxError
						? "invalid_response"
						: error instanceof TypeError
							? "unreachable"
							: "failed";
	return {
		service: runtimeHostService,
		code: "RUNTIME_FILE_EXCHANGE_UNAVAILABLE",
		operation: track.operation,
		reason,
		...(track.status === undefined ? {} : { status: track.status }),
		...(message && stableErrorCode.test(message) ? { error: message } : {}),
		...(typeof causeCode === "string" && transportErrorCode.test(causeCode)
			? { cause: causeCode }
			: {}),
	};
}

const maximumResponseBytes = 65_536;

/**
 * #3314：平台对本次请求作出的确定拒绝。4xx 表示平台已判定该请求不被允许（含 404
 * RESOURCE_UNAVAILABLE 统一表达的撤权、停止、终态、fence 前进与附件不在签名清单内）；
 * 408 与 429 只说明平台暂时没有处理，与超时、断连、5xx 一样无法确认，不算拒绝。
 */
function explicitlyRejected(status: number) {
	return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

const DNS_NAME =
	/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * 文件交换 origin 的唯一校验规则，读取配置与组装 FileBridge 共用（#3255）。
 * 必须是不含凭据、路径、查询和片段的精确 HTTP(S) origin；集群内明文只允许 DNS
 * Service 名称（ADR-0020），TLS 可以使用部署批准的外部地址。
 */
export function isRuntimeFileExchangeOriginV1(value: string) {
	let origin: URL;
	try {
		origin = new URL(value);
	} catch {
		return false;
	}
	return (
		value.length <= 512 &&
		(origin.protocol === "http:" || origin.protocol === "https:") &&
		origin.origin === value &&
		origin.username === "" &&
		origin.password === "" &&
		(origin.pathname === "/" || origin.pathname === "") &&
		origin.search === "" &&
		origin.hash === "" &&
		(origin.protocol === "https:" ||
			(DNS_NAME.test(origin.hostname) &&
				!IPV4.test(origin.hostname) &&
				!origin.hostname.startsWith("[")))
	);
}

function invalid(): never {
	throw new Error("RUNTIME_FILE_EXCHANGE_CONFIGURATION_INVALID");
}

function idempotency(
	binding: RuntimeFileBridgeBindingV1,
	operation: "read" | "result",
	value: string | FileDescriptorV1,
	options?: RuntimeFileResultOptionsV1,
) {
	// #3226：同一执行中内容相同、工作区引用不同的结果是不同的意图；未给出引用的旧调用方
	// 保持原有的键。
	const normalizedValue =
		typeof value === "string"
			? value
			: [
					value.name,
					value.mediaType,
					value.sizeBytes,
					value.sha256,
					...(options ? [options.workspaceReference] : []),
				];
	return createHash("sha256")
		.update(
			JSON.stringify([
				binding.actorId,
				binding.agentId,
				binding.channelId,
				binding.conversationId,
				binding.executionId,
				binding.sessionGeneration,
				binding.grantId,
				operation,
				normalizedValue,
			]),
		)
		.digest("hex");
}

function sameDescriptor(left: FileDescriptorV1, right: FileDescriptorV1) {
	return (
		left.name === right.name &&
		left.mediaType === right.mediaType &&
		left.sizeBytes === right.sizeBytes &&
		left.sha256 === right.sha256
	);
}

async function boundedJson(response: Response) {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("RUNTIME_FILE_EXCHANGE_RESPONSE_INVALID");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > maximumResponseBytes) {
				await reader.cancel().catch(() => undefined);
				throw new Error("RUNTIME_FILE_EXCHANGE_RESPONSE_TOO_LARGE");
			}
			chunks.push(next.value);
		}
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(
				Buffer.concat(chunks, bytes),
			),
		);
	} finally {
		reader.releaseLock();
	}
}

function assertFreshAccess(access: {
	expiresAt: string;
	file: { expiresAt: string };
}) {
	const now = Date.now();
	if (
		Date.parse(access.expiresAt) <= now ||
		Date.parse(access.file.expiresAt) <= now
	)
		throw new Error("RUNTIME_FILE_EXCHANGE_EXPIRED");
}

function boundedUpload(
	body: ReadableStream<Uint8Array>,
	expectedBytes: number,
) {
	const reader = body.getReader();
	let bytes = 0;
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await reader.read();
				if (next.done) {
					if (bytes !== expectedBytes)
						throw new Error("RUNTIME_FILE_RESULT_SIZE_MISMATCH");
					controller.close();
					return;
				}
				bytes += next.value.byteLength;
				if (bytes > expectedBytes)
					throw new Error("RUNTIME_FILE_RESULT_SIZE_MISMATCH");
				controller.enqueue(next.value);
			} catch (error) {
				await reader.cancel().catch(() => undefined);
				controller.error(error);
			}
		},
		async cancel() {
			cancelled = true;
			await reader.cancel();
		},
	});
	return {
		stream,
		async cancel() {
			if (cancelled) return;
			cancelled = true;
			await reader.cancel().catch(() => undefined);
		},
	};
}

export function createRuntimeFileBridgeFactoryV1(
	options: RuntimeFileExchangeOptionsV1,
): RuntimeFileBridgeFactoryV1 {
	if (!isRuntimeFileExchangeOriginV1(options.origin)) invalid();
	const origin = new URL(options.origin);
	if (
		!options.serviceToken ||
		options.serviceToken.length < 32 ||
		(options.timeoutMs !== undefined &&
			(!Number.isSafeInteger(options.timeoutMs) ||
				options.timeoutMs < 1 ||
				options.timeoutMs > 300_000))
	)
		invalid();
	const send = options.fetch ?? fetch;
	const timeoutMs = options.timeoutMs ?? 30_000;
	const logDiagnostic =
		options.logDiagnostic ??
		((entry: RuntimeFileExchangeDiagnosticV1) =>
			console.error(JSON.stringify(entry)));
	function report(track: RuntimeFileExchangeTrackV1, error: unknown) {
		try {
			logDiagnostic(runtimeFileExchangeDiagnosticV1(track, error));
		} catch {
			// 诊断失败不能改变原错误。
		}
	}
	const exchangeUrl = new URL("/internal/v1/files/runtime-exchange", origin);

	/**
	 * 执行数据面同时要求 File Grant 与部署服务身份（工程 Spec §15.4.2）：读取、写入与完成
	 * 都带上与交换请求相同的服务凭据，会话 Sandbox 中即本 Sandbox 的派生凭据（#3281）。
	 */
	function dataPlaneHeaders(grant: string) {
		return {
			Authorization: `Bearer ${options.serviceToken}`,
			"X-Platform-File-Grant": grant,
		};
	}

	function target(path: string) {
		const url = new URL(path, origin);
		if (
			url.origin !== origin.origin ||
			!url.pathname.startsWith("/api/v1/conversations/")
		)
			throw new Error("RUNTIME_FILE_EXCHANGE_TARGET_INVALID");
		return url;
	}

	async function exchange(
		value: unknown,
		key: string,
		track: RuntimeFileExchangeTrackV1,
		/** #3314：平台明确拒绝时抛出的错误；省略时保持原有的不可用错误。 */
		rejected?: () => Error,
	) {
		const request = RuntimeFileExchangeRequestV2Schema.parse(value);
		const response = await send(exchangeUrl, {
			method: "POST",
			redirect: "error",
			signal: AbortSignal.timeout(timeoutMs),
			headers: {
				Authorization: `Bearer ${options.serviceToken}`,
				"Content-Type": "application/json",
				"Idempotency-Key": key,
			},
			body: JSON.stringify(request),
		});
		if (!response.ok) {
			track.status = response.status;
			// 释放响应体失败不能改变平台已经给出的判定。
			await response.body?.cancel().catch(() => undefined);
			if (rejected && explicitlyRejected(response.status)) throw rejected();
			throw new Error("RUNTIME_FILE_EXCHANGE_UNAVAILABLE");
		}
		const access = FileAccessResponseV1Schema.parse(
			await boundedJson(response),
		);
		assertFreshAccess(access);
		return access;
	}

	return (binding, evidence: RuntimeFileExchangeEvidenceV1) => {
		if (!evidence?.executionGrant?.token)
			throw new Error("RUNTIME_FILE_EXCHANGE_EVIDENCE_INVALID");
		const rawPort = {
			async readInput(fileId: string): Promise<RuntimeFileInputV1> {
				const track: RuntimeFileExchangeTrackV1 = { operation: "exchange" };
				let response: Response;
				let access: Awaited<ReturnType<typeof exchange>>;
				try {
					if (!binding.inputFileIds.includes(fileId))
						throw new Error("RUNTIME_FILE_INPUT_NOT_AUTHORIZED");
					const key = idempotency(binding, "read", fileId);
					access = await exchange(
						{
							schemaVersion: 2,
							executionGrant: evidence.executionGrant,
							operation: "read",
							fileId,
							idempotencyKey: key,
						},
						key,
						track,
						() => new RuntimeFileInputRejectedError(),
					);
					if (
						access.file.fileId !== fileId ||
						access.file.kind !== "attachment" ||
						access.file.status !== "available"
					)
						throw new Error("RUNTIME_FILE_INPUT_UNAVAILABLE");
					track.operation = "read";
					response = await send(target(access.path), {
						redirect: "error",
						signal: AbortSignal.timeout(timeoutMs),
						headers: dataPlaneHeaders(access.grant.token),
					});
					if (!response.ok || !response.body) {
						if (!response.ok) track.status = response.status;
						await response.body?.cancel().catch(() => undefined);
						// #3314：数据面的 4xx 同样是平台对本次读取的明确拒绝。
						if (!response.ok && explicitlyRejected(response.status))
							throw new RuntimeFileInputRejectedError();
						throw new Error("RUNTIME_FILE_INPUT_UNAVAILABLE");
					}
				} catch (error) {
					report(track, error);
					throw error;
				}
				const reader = response.body.getReader();
				let bytes = 0;
				const body = new ReadableStream<Uint8Array>({
					async pull(controller) {
						try {
							const next = await reader.read();
							if (next.done) {
								if (bytes !== access.file.descriptor.sizeBytes)
									throw new Error("RUNTIME_FILE_INPUT_SIZE_MISMATCH");
								controller.close();
								return;
							}
							bytes += next.value.byteLength;
							if (bytes > access.file.descriptor.sizeBytes)
								throw new Error("RUNTIME_FILE_INPUT_SIZE_MISMATCH");
							controller.enqueue(next.value);
						} catch (error) {
							// 读取过程中断（连接重置、超时或大小不符）同样记录诊断。
							report({ operation: "read" }, error);
							await reader.cancel().catch(() => undefined);
							controller.error(error);
						}
					},
					async cancel() {
						await reader.cancel();
					},
				});
				return {
					fileId,
					descriptor: access.file.descriptor,
					body,
				};
			},
			async writeResult(
				descriptor: FileDescriptorV1,
				body: ReadableStream<Uint8Array>,
				options?: RuntimeFileResultOptionsV1,
			): Promise<RuntimeFileResultV1> {
				const key = idempotency(binding, "result", descriptor, options);
				const track: RuntimeFileExchangeTrackV1 = { operation: "exchange" };
				let bounded: ReturnType<typeof boundedUpload> | undefined;
				try {
					const access = await exchange(
						{
							schemaVersion: 2,
							executionGrant: evidence.executionGrant,
							operation: "result",
							descriptor,
							...(options
								? { workspaceReference: options.workspaceReference }
								: {}),
							idempotencyKey: key,
						},
						key,
						track,
					);
					if (
						access.file.kind !== "result" ||
						!sameDescriptor(access.file.descriptor, descriptor)
					)
						throw new Error("RUNTIME_FILE_RESULT_INVALID");
					const headers = {
						...dataPlaneHeaders(access.grant.token),
						"Content-Type": descriptor.mediaType,
						"Content-Length": String(descriptor.sizeBytes),
					};
					if (access.file.status === "pending") {
						track.operation = "write";
						bounded = boundedUpload(body, descriptor.sizeBytes);
						const response = await send(target(access.path), {
							method: "PUT",
							duplex: "half",
							redirect: "error",
							signal: AbortSignal.timeout(timeoutMs),
							headers,
							body: bounded.stream,
						} as RequestInit & { duplex: "half" });
						await response.body?.cancel();
						if (!response.ok) {
							track.status = response.status;
							throw new Error("RUNTIME_FILE_RESULT_UPLOAD_FAILED");
						}
					} else {
						await body.cancel();
					}
					track.operation = "complete";
					const completePath = target(
						access.path.replace(/\/content$/, "/complete"),
					);
					// #3226：完成请求一旦发出，对象可能已被确认。只有平台明确拒绝（4xx）才是失败；
					// 传输中断、5xx 或无法解析的响应都无法确认结果，交给调用方记为 unknown。
					let response: Response;
					try {
						response = await send(completePath, {
							method: "POST",
							redirect: "error",
							signal: AbortSignal.timeout(timeoutMs),
							headers: {
								...dataPlaneHeaders(access.grant.token),
								"Content-Type": "application/json",
							},
							body: JSON.stringify({
								schemaVersion: 1,
								accessId: access.accessId,
							}),
						});
					} catch (error) {
						throw new RuntimeFileResultUnconfirmedError({ cause: error });
					}
					if (!response.ok) {
						track.status = response.status;
						await response.body?.cancel().catch(() => undefined);
						if (response.status >= 400 && response.status < 500)
							throw new Error("RUNTIME_FILE_RESULT_COMPLETE_FAILED");
						throw new RuntimeFileResultUnconfirmedError();
					}
					let file: RuntimeFileResultV1;
					try {
						file = FileProjectionV1Schema.parse(await boundedJson(response));
					} catch (error) {
						throw new RuntimeFileResultUnconfirmedError({ cause: error });
					}
					if (
						file.fileId !== access.file.fileId ||
						file.status !== "available" ||
						!sameDescriptor(file.descriptor, descriptor)
					)
						throw new RuntimeFileResultUnconfirmedError();
					return file;
				} catch (error) {
					report(track, error);
					await bounded?.cancel().catch(() => undefined);
					if (!body.locked) await body.cancel().catch(() => undefined);
					throw error;
				}
			},
		};
		return createRuntimeFileBridgeV1({
			binding,
			readInput: (context) => rawPort.readInput(context.fileId),
			writeResult: (descriptor, body, _context, options) =>
				rawPort.writeResult(descriptor, body, options),
			now: () => Date.now(),
			isRevoked: () => false,
			isCurrent: () => true,
		});
	};
}
