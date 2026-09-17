import {
	type FileAccessClaimsV1,
	type FileAccessGrantV1,
	FileAccessRequestV1Schema,
	FileAccessResponseV1Schema,
	FileCompleteRequestV1Schema,
	FileExchangeRequestV1Schema,
	FileIntentRequestV1Schema,
	FileLimitsV1Schema,
	FileProjectionV1Schema,
} from "@agent-infra/contracts/files";
import {
	type ObjectStorageDataV1,
	ObjectStorageError,
} from "@agent-infra/object-storage";
import {
	type createFileAuthorityV1,
	FileAuthorityError,
	type FileAuthorizationPortV1,
	type FileRecordV1,
} from "@agent-infra/platform-core";
import type { Context, Hono } from "hono";
import type { createFileGrantCodecV1 } from "../file-grants.js";
import {
	HttpProtocolError,
	parseIdempotencyKey,
	parseJson,
	requestMetadata,
} from "./common.js";

export interface FileRoutesDependenciesV1 {
	readonly service: ReturnType<typeof createFileAuthorityV1>;
	readonly storage: ObjectStorageDataV1;
	readonly codec: ReturnType<typeof createFileGrantCodecV1>;
	readonly authorization: (
		request: Request,
		execution?: FileAccessClaimsV1,
	) => FileAuthorizationPortV1;
	readonly maxConcurrentTransfers: number;
	readonly exchange?: {
		authenticate(
			request: Request,
			grant: FileAccessGrantV1,
		): Promise<{
			conversationId: string;
			authorization: FileAuthorizationPortV1;
		}>;
	};
}
export function fileProjectionV1(file: FileRecordV1) {
	return FileProjectionV1Schema.parse({
		schemaVersion: 1,
		fileId: file.fileId,
		kind: file.kind,
		descriptor: file.descriptor,
		status: file.status,
		createdAt: file.createdAt,
		expiresAt: file.expiresAt,
	});
}
export function registerFileRoutesV1(
	app: Hono,
	dependencies: FileRoutesDependenciesV1,
) {
	if (
		!Number.isSafeInteger(dependencies.maxConcurrentTransfers) ||
		dependencies.maxConcurrentTransfers < 1
	)
		throw new Error("File transfer limit is invalid");
	let activeTransfers = 0;
	const root = "/api/v1/conversations/:conversationId/files";
	const target = (context: Context) => ({
		conversationId: context.req.param("conversationId") ?? "",
		fileId: context.req.param("fileId") ?? "",
	});
	function denied(context: Context): never {
		throw new HttpProtocolError(
			"RESOURCE_UNAVAILABLE",
			requestMetadata(context.req.raw).traceId,
		);
	}
	function authorization(context: Context, operation: "read" | "write") {
		let claims: FileAccessClaimsV1;
		try {
			claims = dependencies.codec.verify({
				schemaVersion: 1,
				format: "compact-jws",
				token: context.req.header("X-Platform-File-Grant"),
			});
		} catch {
			return denied(context);
		}
		const binding = target(context);
		if (
			claims.conversationId !== binding.conversationId ||
			claims.fileId !== binding.fileId ||
			claims.operation !== operation
		)
			return denied(context);
		return {
			claims,
			port: dependencies.authorization(
				context.req.raw,
				claims.execution ? claims : undefined,
			),
		};
	}
	function handle(handler: (context: Context) => Promise<Response>) {
		return async (context: Context) => {
			context.header("Cache-Control", "private, no-store");
			context.header("X-Content-Type-Options", "nosniff");
			try {
				return await handler(context);
			} catch (error) {
				const traceId = requestMetadata(context.req.raw).traceId;
				if (error instanceof HttpProtocolError) throw error;
				if (
					error instanceof FileAuthorityError ||
					error instanceof ObjectStorageError
				) {
					const code =
						error.code === "denied" ||
						error.code === "expired" ||
						error.code === "missing"
							? "RESOURCE_UNAVAILABLE"
							: error.code === "conflict"
								? "CONFLICT"
								: error.code === "invalid"
									? "INVALID_REQUEST"
									: "DEPENDENCY_UNAVAILABLE";
					throw new HttpProtocolError(code, traceId);
				}
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
			}
		};
	}
	app.get(
		`${root}/limits`,
		handle(async (context) => {
			const limits = await dependencies.service.getLimits(
				target(context).conversationId,
				dependencies.authorization(context.req.raw),
			);
			return context.json(
				FileLimitsV1Schema.parse({ schemaVersion: 1, ...limits }),
			);
		}),
	);
	app.post(
		"/internal/v1/files/exchange",
		handle(async (context) => {
			if (!dependencies.exchange) return denied(context);
			const request = context.req.raw;
			const traceId = requestMetadata(request).traceId;
			const { value } = await parseJson(
				request,
				FileExchangeRequestV1Schema,
				traceId,
			);
			let trusted: Awaited<
				ReturnType<
					NonNullable<FileRoutesDependenciesV1["exchange"]>["authenticate"]
				>
			>;
			try {
				trusted = await dependencies.exchange.authenticate(
					request,
					value.executionGrant,
				);
			} catch {
				return denied(context);
			}
			const key = parseIdempotencyKey(request, traceId);
			const file =
				value.operation === "result"
					? await dependencies.service.createResult(
							{
								conversationId: trusted.conversationId,
								idempotencyKey: key,
								descriptor: value.descriptor,
							},
							trusted.authorization,
						)
					: await dependencies.service.getFile(
							{ conversationId: trusted.conversationId, fileId: value.fileId },
							trusted.authorization,
						);
			const access = await dependencies.service.issueAccess(
				{
					conversationId: file.conversationId,
					fileId: file.fileId,
					operation: value.operation === "result" ? "write" : "read",
					idempotencyKey: value.accessIdempotencyKey ?? key,
				},
				trusted.authorization,
			);
			return context.json(
				FileAccessResponseV1Schema.parse({
					schemaVersion: 1,
					accessId: access.accessId,
					file: fileProjectionV1(file),
					path: `/api/v1/conversations/${encodeURIComponent(file.conversationId)}/files/${encodeURIComponent(file.fileId)}/content`,
					grant: dependencies.codec.sign(access),
					expiresAt: access.expiresAt,
				}),
			);
		}),
	);
	app.post(
		root,
		handle(async (context) => {
			const request = context.req.raw;
			const traceId = requestMetadata(request).traceId;
			const { value } = await parseJson(
				request,
				FileIntentRequestV1Schema,
				traceId,
			);
			const file = await dependencies.service.createUpload(
				{
					conversationId: target(context).conversationId,
					descriptor: value.descriptor,
					idempotencyKey: parseIdempotencyKey(request, traceId),
				},
				dependencies.authorization(request),
			);
			return context.json(fileProjectionV1(file), 201);
		}),
	);
	app.post(
		`${root}/:fileId/access`,
		handle(async (context) => {
			const request = context.req.raw;
			const { value } = await parseJson(
				request,
				FileAccessRequestV1Schema,
				requestMetadata(request).traceId,
			);
			const idempotencyKey = parseIdempotencyKey(
				request,
				requestMetadata(request).traceId,
			);
			const port = dependencies.authorization(request);
			const access = await dependencies.service.issueAccess(
				{ ...target(context), operation: value.operation, idempotencyKey },
				port,
			);
			const file = await dependencies.service.getFile(target(context), port);
			return context.json(
				FileAccessResponseV1Schema.parse({
					schemaVersion: 1,
					accessId: access.accessId,
					file: fileProjectionV1(file),
					path: `/api/v1/conversations/${encodeURIComponent(file.conversationId)}/files/${encodeURIComponent(file.fileId)}/content`,
					grant: dependencies.codec.sign(access),
					expiresAt: access.expiresAt,
				}),
			);
		}),
	);
	app.post(
		`${root}/:fileId/complete`,
		handle(async (context) => {
			const { claims, port } = authorization(context, "write");
			const { value } = await parseJson(
				context.req.raw,
				FileCompleteRequestV1Schema,
				requestMetadata(context.req.raw).traceId,
			);
			if (value.accessId !== claims.accessId) return denied(context);
			if (activeTransfers >= dependencies.maxConcurrentTransfers)
				throw new HttpProtocolError(
					"DEPENDENCY_UNAVAILABLE",
					requestMetadata(context.req.raw).traceId,
				);
			activeTransfers++;
			try {
				const file = await dependencies.service.complete(
					{ ...target(context), accessId: claims.accessId },
					port,
				);
				return context.json(fileProjectionV1(file));
			} finally {
				activeTransfers--;
			}
		}),
	);
	app.put(
		`${root}/:fileId/content`,
		handle(async (context) => {
			const { claims, port } = authorization(context, "write");
			const request = {
				...target(context),
				accessId: claims.accessId,
				operation: "write" as const,
			};
			const { file, access } = await dependencies.service.authorizeAccess(
				request,
				port,
			);
			if (
				context.req.header("Content-Type") !== file.descriptor.mediaType ||
				context.req.header("Content-Length") !==
					String(file.descriptor.sizeBytes) ||
				!context.req.raw.body
			)
				throw new HttpProtocolError(
					"INVALID_REQUEST",
					requestMetadata(context.req.raw).traceId,
				);
			if (activeTransfers >= dependencies.maxConcurrentTransfers)
				throw new HttpProtocolError(
					"DEPENDENCY_UNAVAILABLE",
					requestMetadata(context.req.raw).traceId,
				);
			activeTransfers++;
			try {
				await dependencies.storage.upload({
					objectRef: file.objectRef,
					descriptor: file.descriptor,
					expiresAt: access.expiresAt,
					body: context.req.raw.body,
					signal: context.req.raw.signal,
				});
				await dependencies.service.authorizeAccess(request, port);
				return context.body(null, 204);
			} finally {
				activeTransfers--;
			}
		}),
	);
	app.get(
		`${root}/:fileId/content`,
		handle(async (context) => {
			const { claims, port } = authorization(context, "read");
			const { file, access } = await dependencies.service.authorizeAccess(
				{ ...target(context), accessId: claims.accessId, operation: "read" },
				port,
			);
			if (!file.objectVersion || !file.etag) return denied(context);
			if (activeTransfers >= dependencies.maxConcurrentTransfers)
				throw new HttpProtocolError(
					"DEPENDENCY_UNAVAILABLE",
					requestMetadata(context.req.raw).traceId,
				);
			activeTransfers++;
			let released = false;
			let cancelTransfer: (() => void) | undefined;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const release = () => {
				if (!released) {
					released = true;
					if (timer) clearTimeout(timer);
					if (cancelTransfer)
						context.req.raw.signal.removeEventListener("abort", cancelTransfer);
					activeTransfers--;
				}
			};
			try {
				const body = await dependencies.storage.download({
					objectRef: file.objectRef,
					version: file.objectVersion,
					etag: file.etag,
					expiresAt: access.expiresAt,
					signal: context.req.raw.signal,
				});
				const reader = body.getReader();
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						cancelTransfer = () => {
							if (released) return;
							release();
							controller.error(new Error("File transfer interrupted"));
							void reader.cancel().catch(() => undefined);
						};
						timer = setTimeout(
							cancelTransfer,
							Math.max(
								0,
								Math.min(300000, Date.parse(access.expiresAt) - Date.now()),
							),
						);
						timer.unref();
						context.req.raw.signal.addEventListener("abort", cancelTransfer, {
							once: true,
						});
						if (context.req.raw.signal.aborted) cancelTransfer();
					},
					async pull(controller) {
						try {
							const value = await reader.read();
							if (value.done) {
								release();
								controller.close();
							} else controller.enqueue(value.value);
						} catch {
							release();
							controller.error(new Error("File transfer interrupted"));
						}
					},
					async cancel() {
						release();
						await reader.cancel();
					},
				});
				return new Response(stream, {
					headers: {
						"Content-Type": file.descriptor.mediaType,
						"Content-Length": String(file.descriptor.sizeBytes),
						"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.descriptor.name)}`,
						"Cache-Control": "private, no-store",
						"X-Content-Type-Options": "nosniff",
					},
				});
			} catch (error) {
				release();
				throw error;
			}
		}),
	);
}
