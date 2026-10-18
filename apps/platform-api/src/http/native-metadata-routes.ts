import type { NativeMetadataProjectionV1 } from "@agent-infra/contracts/runtime";
import type { Hono } from "hono";
import {
	createRuntimeNativeMetadataRequestContextV1,
	type RuntimeNativeMetadataRequestContextV1,
} from "../runtime-native-metadata-request-context.js";

import {
	HttpProtocolError,
	type RequestMetadata,
	requestMetadata,
} from "./common.js";
import {
	type IdentityAdapter,
	type IdentityContext,
	resolveIdentity,
} from "./identity.js";

export interface RuntimeNativeMetadataPublicReaderV1 {
	read(
		identity: IdentityContext,
		conversationId: string,
		executionId: string,
		selector: "status" | "commands" | "skills",
		requestContext: RuntimeNativeMetadataRequestContextV1,
	): Promise<NativeMetadataProjectionV1 | null>;
}

export interface NativeMetadataRoutesDependenciesV1 {
	readonly identity: IdentityAdapter;
	readonly reader: RuntimeNativeMetadataPublicReaderV1;
}

function invalid(metadata: RequestMetadata): never {
	throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
}

function selector(request: Request, metadata: RequestMetadata) {
	const search = new URL(request.url).searchParams;
	const keys = [...search.keys()];
	if (
		keys.length !== 1 ||
		keys[0] !== "selector" ||
		search.getAll("selector").length !== 1
	)
		invalid(metadata);
	const value = search.get("selector");
	if (value !== "status" && value !== "commands" && value !== "skills")
		invalid(metadata);
	return value;
}

function responseError(error: unknown, metadata: RequestMetadata) {
	return error instanceof HttpProtocolError
		? error
		: new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
}

/** Register the optional public V2 native metadata read route. */
export function registerNativeMetadataRoutes(
	app: Hono,
	dependencies: NativeMetadataRoutesDependenciesV1,
) {
	app.get(
		"/api/v2/conversations/:conversationId/executions/:executionId/native-metadata",
		async (context) => {
			const metadata = requestMetadata(context.req.raw);
			const requestContext = createRuntimeNativeMetadataRequestContextV1({
				signal: context.req.raw.signal,
				authenticate: () =>
					resolveIdentity(
						dependencies.identity,
						context.req.raw,
						metadata.traceId,
					),
			});
			try {
				const identity = await requestContext.authenticate();
				const projection = await requestContext.run(() =>
					dependencies.reader.read(
						identity,
						context.req.param("conversationId"),
						context.req.param("executionId"),
						selector(context.req.raw, metadata),
						requestContext,
					),
				);
				if (!projection)
					throw new HttpProtocolError(
						"DEPENDENCY_UNAVAILABLE",
						metadata.traceId,
					);
				await requestContext.verifyDelivery(identity);
				return context.json(projection);
			} catch (error) {
				const protocol = responseError(error, metadata);
				return context.json(protocol.body, protocol.status);
			} finally {
				requestContext.close();
			}
		},
	);
}
