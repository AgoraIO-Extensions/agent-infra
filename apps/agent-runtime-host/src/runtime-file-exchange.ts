import { createHash } from "node:crypto";
import type {
	RuntimeFileBridgeBindingV1,
	RuntimeFileBridgeFactoryV1,
	RuntimeFileBridgePortV1,
	RuntimeFileInputV1,
	RuntimeFileResultV1,
} from "@agent-infra/agent-runtime";
import {
	FileAccessResponseV1Schema,
	type FileDescriptorV1,
	FileProjectionV1Schema,
	RuntimeFileExchangeRequestV1Schema,
} from "@agent-infra/contracts/files";

export interface RuntimeFileExchangeOptionsV1 {
	readonly origin: string;
	readonly serviceToken: string;
	readonly timeoutMs?: number;
	readonly fetch?: typeof fetch;
}

function invalid(): never {
	throw new Error("RUNTIME_FILE_EXCHANGE_CONFIGURATION_INVALID");
}

function idempotency(
	binding: RuntimeFileBridgeBindingV1,
	operation: "read" | "result",
	value: string | FileDescriptorV1,
) {
	const normalizedValue =
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

export function createRuntimeFileBridgeFactoryV1(
	options: RuntimeFileExchangeOptionsV1,
): RuntimeFileBridgeFactoryV1 {
	let origin: URL;
	try {
		origin = new URL(options.origin);
	} catch {
		invalid();
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
			throw new Error("RUNTIME_FILE_EXCHANGE_UNAVAILABLE");
		}
		return FileAccessResponseV1Schema.parse(await response.json());
	}

	return (binding) => {
		const port: RuntimeFileBridgePortV1 = {
			async readInput(fileId: string): Promise<RuntimeFileInputV1> {
				if (!binding.inputFileIds.includes(fileId))
					throw new Error("RUNTIME_FILE_INPUT_NOT_AUTHORIZED");
				const key = idempotency(binding, "read", fileId);
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
			): Promise<RuntimeFileResultV1> {
				const key = idempotency(binding, "result", descriptor);
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
						!sameDescriptor(access.file.descriptor, descriptor)
					)
						throw new Error("RUNTIME_FILE_RESULT_INVALID");
					const headers = {
						"X-Platform-File-Grant": access.grant.token,
						"Content-Type": descriptor.mediaType,
						"Content-Length": String(descriptor.sizeBytes),
					};
					if (access.file.status === "pending") {
						const response = await send(target(access.path), {
							method: "PUT",
							duplex: "half",
							redirect: "error",
							signal: AbortSignal.timeout(timeoutMs),
							headers,
							body,
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
					const response = await send(completePath, {
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
					if (!response.ok)
						throw new Error("RUNTIME_FILE_RESULT_COMPLETE_FAILED");
					const file = FileProjectionV1Schema.parse(await response.json());
					if (
						file.fileId !== access.file.fileId ||
						file.status !== "available" ||
						!sameDescriptor(file.descriptor, descriptor)
					)
						throw new Error("RUNTIME_FILE_RESULT_INVALID");
					return file;
				} catch (error) {
					if (!body.locked) await body.cancel().catch(() => undefined);
					throw error;
				}
			},
		};
		return port;
	};
}
