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
	RuntimeFileResultUnconfirmedError,
} from "@agent-infra/agent-runtime";
import {
	FileAccessResponseV1Schema,
	type FileDescriptorV1,
	FileProjectionV1Schema,
	RuntimeFileExchangeRequestV2Schema,
} from "@agent-infra/contracts/files";

export interface RuntimeFileExchangeOptionsV1 {
	readonly origin: string;
	readonly serviceToken: string;
	readonly timeoutMs?: number;
	readonly fetch?: typeof fetch;
}

const maximumResponseBytes = 65_536;

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
	const exchangeUrl = new URL("/internal/v1/files/runtime-exchange", origin);

	function target(path: string) {
		const url = new URL(path, origin);
		if (
			url.origin !== origin.origin ||
			!url.pathname.startsWith("/api/v1/conversations/")
		)
			throw new Error("RUNTIME_FILE_EXCHANGE_TARGET_INVALID");
		return url;
	}

	async function exchange(value: unknown, key: string) {
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
			await response.body?.cancel();
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
				if (!binding.inputFileIds.includes(fileId))
					throw new Error("RUNTIME_FILE_INPUT_NOT_AUTHORIZED");
				const key = idempotency(binding, "read", fileId);
				const access = await exchange(
					{
						schemaVersion: 2,
						executionGrant: evidence.executionGrant,
						operation: "read",
						fileId,
						idempotencyKey: key,
					},
					key,
				);
				if (
					access.file.fileId !== fileId ||
					access.file.kind !== "attachment" ||
					access.file.status !== "available"
				)
					throw new Error("RUNTIME_FILE_INPUT_UNAVAILABLE");
				const response = await send(target(access.path), {
					redirect: "error",
					signal: AbortSignal.timeout(timeoutMs),
					headers: { "X-Platform-File-Grant": access.grant.token },
				});
				if (!response.ok || !response.body) {
					await response.body?.cancel();
					throw new Error("RUNTIME_FILE_INPUT_UNAVAILABLE");
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
					);
					if (
						access.file.kind !== "result" ||
						!sameDescriptor(access.file.descriptor, descriptor)
					)
						throw new Error("RUNTIME_FILE_RESULT_INVALID");
					const headers = {
						"X-Platform-File-Grant": access.grant.token,
						"Content-Type": descriptor.mediaType,
						"Content-Length": String(descriptor.sizeBytes),
					};
					if (access.file.status === "pending") {
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
						if (!response.ok)
							throw new Error("RUNTIME_FILE_RESULT_UPLOAD_FAILED");
					} else {
						await body.cancel();
					}
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
								"X-Platform-File-Grant": access.grant.token,
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
