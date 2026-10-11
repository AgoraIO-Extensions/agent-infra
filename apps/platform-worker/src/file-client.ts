import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import type {
	RuntimeFileBridgeBindingV1,
	RuntimeFileBridgeFactoryV1,
	RuntimeFileBridgePortV1,
	RuntimeFileInputV1,
	RuntimeFileResultReceiptV1,
} from "@agent-infra/agent-runtime";
import { createRuntimeFileResultReceiptV1 } from "@agent-infra/agent-runtime";
import {
	type FileAccessGrantV1,
	FileAccessResponseV1Schema,
	type FileDescriptorV1,
	FileProjectionV1Schema,
	RuntimeFileExchangeRequestV1Schema,
} from "@agent-infra/contracts/files";

const runtimeFileResponseLimit = 65_536;

export interface WorkerRuntimeFileExchangeOptionsV1 {
	readonly origin: string;
	readonly serviceToken: string;
	readonly timeoutMs?: number;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	readonly isCurrent?: (binding: RuntimeFileBridgeBindingV1) => boolean;
}

function runtimeFileInvalid(): never {
	throw new Error("WORKER_RUNTIME_FILE_EXCHANGE_CONFIGURATION_INVALID");
}

function runtimeFileKey(
	binding: RuntimeFileBridgeBindingV1,
	operation: "read" | "result",
	value: string | FileDescriptorV1,
) {
	const normalized =
		typeof value === "string"
			? value
			: [value.name, value.mediaType, value.sizeBytes, value.sha256];
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
				normalized,
			]),
		)
		.digest("hex");
}

function sameFileDescriptor(left: FileDescriptorV1, right: FileDescriptorV1) {
	return (
		left.name === right.name &&
		left.mediaType === right.mediaType &&
		left.sizeBytes === right.sizeBytes &&
		left.sha256 === right.sha256
	);
}

async function boundedRuntimeFileJson(response: Response) {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("WORKER_RUNTIME_FILE_RESPONSE_INVALID");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > runtimeFileResponseLimit) {
				await reader.cancel().catch(() => undefined);
				throw new Error("WORKER_RUNTIME_FILE_RESPONSE_TOO_LARGE");
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

function boundedRuntimeFileUpload(
	body: ReadableStream<Uint8Array>,
	expected: number,
	revalidate: () => void,
) {
	const reader = body.getReader();
	let bytes = 0;
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				revalidate();
				const next = await reader.read();
				revalidate();
				if (next.done) {
					if (bytes !== expected)
						throw new Error("WORKER_RUNTIME_FILE_SIZE_MISMATCH");
					controller.close();
					return;
				}
				bytes += next.value.byteLength;
				if (bytes > expected)
					throw new Error("WORKER_RUNTIME_FILE_SIZE_MISMATCH");
				controller.enqueue(next.value);
			} catch (error) {
				await reader.cancel().catch(() => undefined);
				controller.error(error);
			}
		},
		async cancel() {
			cancelled = true;
			await reader.cancel().catch(() => undefined);
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

/** V4 execution-bound Worker port; legacy FileExchange remains unchanged. */
export function createWorkerRuntimeFileBridgeFactoryV1(
	options: WorkerRuntimeFileExchangeOptionsV1,
): RuntimeFileBridgeFactoryV1 {
	let origin: URL;
	try {
		origin = new URL(options.origin);
	} catch {
		runtimeFileInvalid();
	}
	if (
		origin.protocol !== "https:" ||
		origin.username ||
		origin.password ||
		origin.search ||
		origin.hash ||
		!options.serviceToken ||
		options.serviceToken.length < 32 ||
		(options.timeoutMs !== undefined &&
			(!Number.isSafeInteger(options.timeoutMs) ||
				options.timeoutMs < 1 ||
				options.timeoutMs > 300_000))
	)
		runtimeFileInvalid();
	const send = options.fetch ?? fetch;
	const timeoutMs = options.timeoutMs ?? 30_000;
	const exchangeUrl = new URL("/internal/v1/files/runtime-exchange", origin);
	const now = options.now ?? Date.now;
	const isCurrent = options.isCurrent ?? (() => true);
	function revalidate(binding: RuntimeFileBridgeBindingV1) {
		if (now() >= binding.expiresAt || !isCurrent(binding))
			throw new Error("WORKER_RUNTIME_FILE_BINDING_STALE");
	}
	function target(path: string) {
		const url = new URL(path, origin);
		if (
			url.origin !== origin.origin ||
			!url.pathname.startsWith("/api/v1/conversations/")
		)
			throw new Error("WORKER_RUNTIME_FILE_TARGET_INVALID");
		return url;
	}
	async function exchange(value: unknown, key: string) {
		const request = RuntimeFileExchangeRequestV1Schema.parse(value);
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
			throw new Error("WORKER_RUNTIME_FILE_EXCHANGE_UNAVAILABLE");
		}
		const access = FileAccessResponseV1Schema.parse(
			await boundedRuntimeFileJson(response),
		);
		if (
			Date.parse(access.expiresAt) <= now() ||
			Date.parse(access.file.expiresAt) <= now()
		)
			throw new Error("WORKER_RUNTIME_FILE_ACCESS_EXPIRED");
		return access;
	}
	return (binding) => {
		const port: RuntimeFileBridgePortV1 = {
			revalidate: () => revalidate(binding),
			async readInput(fileId: string): Promise<RuntimeFileInputV1> {
				revalidate(binding);
				if (!binding.inputFileIds.includes(fileId))
					throw new Error("WORKER_RUNTIME_FILE_INPUT_NOT_AUTHORIZED");
				const key = runtimeFileKey(binding, "read", fileId);
				const access = await exchange(
					{
						schemaVersion: 1,
						actorId: binding.actorId,
						agentId: binding.agentId,
						channelId: binding.channelId,
						conversationId: binding.conversationId,
						executionId: binding.executionId,
						sessionGeneration: binding.sessionGeneration,
						grantId: binding.grantId,
						expiresAt: new Date(binding.expiresAt).toISOString(),
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
					throw new Error("WORKER_RUNTIME_FILE_INPUT_UNAVAILABLE");
				const response = await send(target(access.path), {
					redirect: "error",
					signal: AbortSignal.timeout(timeoutMs),
					headers: { "X-Platform-File-Grant": access.grant.token },
				});
				if (!response.ok || !response.body) {
					await response.body?.cancel();
					throw new Error("WORKER_RUNTIME_FILE_INPUT_UNAVAILABLE");
				}
				const reader = response.body.getReader();
				let bytes = 0;
				const body = new ReadableStream<Uint8Array>({
					async pull(controller) {
						try {
							revalidate(binding);
							const next = await reader.read();
							revalidate(binding);
							if (next.done) {
								if (bytes !== access.file.descriptor.sizeBytes)
									throw new Error("WORKER_RUNTIME_FILE_INPUT_SIZE_MISMATCH");
								controller.close();
								return;
							}
							bytes += next.value.byteLength;
							if (bytes > access.file.descriptor.sizeBytes)
								throw new Error("WORKER_RUNTIME_FILE_INPUT_SIZE_MISMATCH");
							controller.enqueue(next.value);
						} catch (error) {
							await reader.cancel().catch(() => undefined);
							controller.error(error);
						}
					},
					async cancel() {
						await reader.cancel().catch(() => undefined);
					},
				});
				return { fileId, descriptor: access.file.descriptor, body };
			},
			async writeResult(
				descriptor: FileDescriptorV1,
				body: ReadableStream<Uint8Array>,
			): Promise<RuntimeFileResultReceiptV1> {
				revalidate(binding);
				const key = runtimeFileKey(binding, "result", descriptor);
				let bounded: ReturnType<typeof boundedRuntimeFileUpload> | undefined;
				try {
					const access = await exchange(
						{
							schemaVersion: 1,
							actorId: binding.actorId,
							agentId: binding.agentId,
							channelId: binding.channelId,
							conversationId: binding.conversationId,
							executionId: binding.executionId,
							sessionGeneration: binding.sessionGeneration,
							grantId: binding.grantId,
							expiresAt: new Date(binding.expiresAt).toISOString(),
							operation: "result",
							descriptor,
							idempotencyKey: key,
						},
						key,
					);
					if (
						access.file.kind !== "result" ||
						!sameFileDescriptor(access.file.descriptor, descriptor)
					)
						throw new Error("WORKER_RUNTIME_FILE_RESULT_INVALID");
					if (access.file.status === "pending") {
						bounded = boundedRuntimeFileUpload(body, descriptor.sizeBytes, () =>
							revalidate(binding),
						);
						const response = await send(target(access.path), {
							method: "PUT",
							duplex: "half",
							redirect: "error",
							signal: AbortSignal.timeout(timeoutMs),
							headers: {
								"X-Platform-File-Grant": access.grant.token,
								"Content-Type": descriptor.mediaType,
								"Content-Length": String(descriptor.sizeBytes),
							},
							body: bounded.stream,
						} as RequestInit & { duplex: "half" });
						await response.body?.cancel();
						if (!response.ok)
							throw new Error("WORKER_RUNTIME_FILE_UPLOAD_FAILED");
					} else await body.cancel();
					const response = await send(
						target(access.path.replace(/\/content$/, "/complete")),
						{
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
						},
					);
					if (!response.ok)
						throw new Error("WORKER_RUNTIME_FILE_COMPLETE_FAILED");
					const file = FileProjectionV1Schema.parse(
						await boundedRuntimeFileJson(response),
					);
					if (
						file.fileId !== access.file.fileId ||
						file.status !== "available" ||
						!sameFileDescriptor(file.descriptor, descriptor)
					)
						throw new Error("WORKER_RUNTIME_FILE_RESULT_INVALID");
					return createRuntimeFileResultReceiptV1(binding, file);
				} catch (error) {
					await bounded?.cancel().catch(() => undefined);
					if (!body.locked) await body.cancel().catch(() => undefined);
					throw error;
				}
			},
		};
		return port;
	};
}

export function createWorkerFileClientV1(options: {
	origin: string;
	serviceToken: string;
	timeoutMs: number;
	fetch?: typeof fetch;
}) {
	const origin = new URL(options.origin);
	if (
		!["http:", "https:"].includes(origin.protocol) ||
		origin.username ||
		origin.password ||
		origin.pathname !== "/" ||
		origin.search ||
		origin.hash ||
		options.serviceToken.length < 32 ||
		!Number.isSafeInteger(options.timeoutMs) ||
		options.timeoutMs < 1
	)
		throw new Error("Invalid file client configuration");
	const send = options.fetch ?? fetch;
	async function exchange(value: object, idempotencyKey: string) {
		const response = await send(
			new URL("/internal/v1/files/exchange", origin),
			{
				method: "POST",
				redirect: "error",
				signal: AbortSignal.timeout(options.timeoutMs),
				headers: {
					Authorization: `Bearer ${options.serviceToken}`,
					"Content-Type": "application/json",
					"Idempotency-Key": idempotencyKey,
				},
				body: JSON.stringify({ schemaVersion: 1, ...value }),
			},
		);
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error("File exchange unavailable");
		}
		return FileAccessResponseV1Schema.parse(await response.json());
	}
	function target(path: string) {
		const url = new URL(path, origin);
		if (
			url.origin !== origin.origin ||
			!url.pathname.startsWith("/api/v1/conversations/")
		)
			throw new Error("Invalid file access target");
		return url;
	}
	return {
		async readInput(
			executionGrant: FileAccessGrantV1,
			fileId: string,
			idempotencyKey: string,
		) {
			try {
				const access = await exchange(
					{ operation: "read", executionGrant, fileId },
					idempotencyKey,
				);
				if (access.file.fileId !== fileId || access.file.status !== "available")
					throw new Error("Invalid file access");
				const response = await send(target(access.path), {
					redirect: "error",
					signal: AbortSignal.timeout(options.timeoutMs),
					headers: {
						Authorization: `Bearer ${options.serviceToken}`,
						"X-Platform-File-Grant": access.grant.token,
					},
				});
				if (!response.ok || !response.body) {
					await response.body?.cancel();
					throw new Error("File read unavailable");
				}
				let bytes = 0;
				return response.body.pipeThrough(
					new TransformStream<Uint8Array, Uint8Array>({
						transform(chunk, controller) {
							bytes += chunk.byteLength;
							if (bytes > access.file.descriptor.sizeBytes)
								throw new Error("File read interrupted");
							controller.enqueue(chunk);
						},
						flush() {
							if (bytes !== access.file.descriptor.sizeBytes)
								throw new Error("File read interrupted");
						},
					}),
				);
			} catch {
				throw new Error("File read unavailable");
			}
		},
		async writeResult(
			executionGrant: FileAccessGrantV1,
			descriptor: FileDescriptorV1,
			body: ReadableStream<Uint8Array>,
			idempotencyKey: string,
			accessIdempotencyKey = idempotencyKey,
		) {
			try {
				const access = await exchange(
					{
						operation: "result",
						executionGrant,
						descriptor,
						accessIdempotencyKey,
					},
					idempotencyKey,
				);
				if (access.file.kind !== "result")
					throw new Error("Invalid file access");
				const headers = {
					Authorization: `Bearer ${options.serviceToken}`,
					"X-Platform-File-Grant": access.grant.token,
				};
				if (access.file.status === "pending") {
					const init: RequestInit & { duplex: "half" } = {
						method: "PUT",
						duplex: "half",
						redirect: "error",
						signal: AbortSignal.timeout(options.timeoutMs),
						headers: {
							...headers,
							"Content-Type": descriptor.mediaType,
							"Content-Length": String(descriptor.sizeBytes),
						},
						body,
					};
					const response = await send(target(access.path), init);
					await response.body?.cancel();
					if (!response.ok) throw new Error("File write unavailable");
				} else {
					await body.cancel();
				}
				const response = await send(
					target(access.path.replace(/\/content$/, "/complete")),
					{
						method: "POST",
						redirect: "error",
						signal: AbortSignal.timeout(options.timeoutMs),
						headers: { ...headers, "Content-Type": "application/json" },
						body: JSON.stringify({
							schemaVersion: 1,
							accessId: access.accessId,
						}),
					},
				);
				if (!response.ok) {
					await response.body?.cancel();
					throw new Error("File completion unavailable");
				}
				const file = FileProjectionV1Schema.parse(await response.json());
				if (file.fileId !== access.file.fileId || file.status !== "available")
					throw new Error("File completion unavailable");
				return file;
			} catch {
				if (!body.locked) await body.cancel().catch(() => undefined);
				throw new Error("File write unavailable");
			}
		},
	};
}
