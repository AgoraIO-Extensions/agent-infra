import { randomUUID, timingSafeEqual } from "node:crypto";
import {
	NativeMetadataCurrentRequestV1Schema,
	NativeMetadataCurrentResponseV1Schema,
	PlatformNativeMetadataReadRequestV1Schema,
} from "@agent-infra/contracts";
import { RuntimeNativeMetadataReadResponseV1Schema } from "@agent-infra/contracts/runtime";
import { ConversationRuntimeHostError } from "@agent-infra/platform-core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { createPlatformNativeMetadataReadWorkerV1 } from "./native-metadata-runtime.js";

class MetadataHttpError extends Error {
	constructor(readonly status: 400 | 401 | 403 | 503) {
		super("Native metadata request failed");
	}
}

/** Credentials identify exact trusted instances; no identity is taken from the body. */
export function createPlatformNativeMetadataAppV1(options: {
	readonly reads: Pick<
		ReturnType<typeof createPlatformNativeMetadataReadWorkerV1>,
		"read" | "current"
	>;
	readonly apiSources: ReadonlyMap<string, string>;
	readonly hosts: ReadonlyMap<string, string>;
}) {
	const tokens = new Set<string>();
	function credentials(entries: ReadonlyMap<string, string>) {
		if (entries.size === 0)
			throw new TypeError("Metadata service map is empty");
		return [...entries].map(([identity, token]) => {
			if (
				!identity ||
				identity.includes("\0") ||
				!/^[\x21-\x7e]{1,8192}$/.test(token) ||
				tokens.has(token)
			)
				throw new TypeError("Metadata service mapping is invalid");
			tokens.add(token);
			return { identity, token: Buffer.from(token) };
		});
	}
	const apiSources = credentials(options.apiSources);
	const hosts = credentials(options.hosts);
	function authenticate(
		header: string | undefined,
		entries: typeof apiSources,
	) {
		if (!header?.startsWith("Bearer ")) throw new MetadataHttpError(401);
		const supplied = Buffer.from(header.slice(7));
		const match = entries.find(
			(entry) =>
				entry.token.length === supplied.length &&
				timingSafeEqual(entry.token, supplied),
		);
		if (!match) throw new MetadataHttpError(401);
		return match.identity;
	}
	function errorBody(status: 400 | 401 | 403 | 503) {
		const code =
			status === 400
				? "NATIVE_METADATA_REQUEST_INVALID"
				: status === 401
					? "NATIVE_METADATA_SERVICE_UNAUTHORIZED"
					: status === 403
						? "NATIVE_METADATA_DENIED"
						: "NATIVE_METADATA_UNAVAILABLE";
		return {
			schemaVersion: 1,
			code,
			message: "Native metadata request failed",
			retryable: status === 503,
			traceId: randomUUID(),
		};
	}
	const app = new Hono<{ Variables: { serviceIdentity: string } }>();
	const limit = bodyLimit({
		maxSize: 65_536,
		onError: (context) => context.json(errorBody(400), 400),
	});
	app.post(
		"/internal/platform-worker/v1/native-metadata/reads",
		async (context, next) => {
			context.set(
				"serviceIdentity",
				authenticate(context.req.header("authorization"), apiSources),
			);
			await next();
		},
		limit,
		async (context) => {
			const request = context.req.raw;
			const parsed = PlatformNativeMetadataReadRequestV1Schema.safeParse(
				await request.json().catch(() => undefined),
			);
			if (!parsed.success || new URL(request.url).search)
				throw new MetadataHttpError(400);
			request.signal.throwIfAborted();
			const response = RuntimeNativeMetadataReadResponseV1Schema.parse(
				await options.reads.read(
					parsed.data,
					context.get("serviceIdentity"),
					request.signal,
				),
			);
			request.signal.throwIfAborted();
			return context.json(response);
		},
	);
	app.post(
		"/internal/platform-worker/v1/native-metadata/reads/:readId/current",
		async (context, next) => {
			context.set(
				"serviceIdentity",
				authenticate(context.req.header("authorization"), hosts),
			);
			await next();
		},
		limit,
		async (context) => {
			const request = context.req.raw;
			const parsed = NativeMetadataCurrentRequestV1Schema.safeParse(
				await request.json().catch(() => undefined),
			);
			if (
				!parsed.success ||
				parsed.data.readId !== context.req.param("readId") ||
				new URL(request.url).search
			)
				throw new MetadataHttpError(400);
			request.signal.throwIfAborted();
			const response = NativeMetadataCurrentResponseV1Schema.parse(
				await options.reads.current(
					parsed.data,
					context.get("serviceIdentity"),
					request.signal,
				),
			);
			request.signal.throwIfAborted();
			return context.json(response);
		},
	);
	app.onError((error, context) => {
		const status =
			error instanceof MetadataHttpError
				? error.status
				: error instanceof ConversationRuntimeHostError &&
						error.code === "NATIVE_METADATA_DENIED"
					? 403
					: 503;
		return context.json(errorBody(status), status);
	});
	return app;
}
