import {
	type FileAccessGrantV1,
	FileAccessResponseV1Schema,
	type FileDescriptorV1,
	FileProjectionV1Schema,
} from "@agent-infra/contracts/files";

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
