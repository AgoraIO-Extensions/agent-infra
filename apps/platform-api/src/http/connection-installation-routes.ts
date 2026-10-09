import { OpaqueIdV1Schema } from "@agent-infra/contracts";
import {
	ConnectionInstallationAuthorizationV1Schema,
	ConnectionInstallationBeginRequestV1Schema,
	ConnectionInstallationConfirmRequestV1Schema,
	ConnectionInstallationProjectionV1Schema,
} from "@agent-infra/contracts/runtime";
import {
	ConnectionInstallationErrorV1,
	type createConnectionInstallationAuthorizationV1,
} from "@agent-infra/platform-core";
import type { Context, Hono } from "hono";
import {
	HttpProtocolError,
	parseIdempotencyKey,
	parseJson,
	requestMetadata,
} from "./common.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

export interface ConnectionInstallationRouteDependenciesV1 {
	readonly identity: IdentityAdapter;
	readonly publicOrigin: string;
	readonly installation: ReturnType<
		typeof createConnectionInstallationAuthorizationV1
	>;
}
export function registerConnectionInstallationRoutesV1(
	app: Hono,
	dependencies: ConnectionInstallationRouteDependenciesV1,
) {
	const origin = new URL(dependencies.publicOrigin);
	if (
		origin.protocol !== "https:" ||
		origin.origin !== dependencies.publicOrigin
	)
		throw new Error("CONNECTION_INSTALLATION_UNAVAILABLE");
	const handle = async (
		context: Context,
		command: "begin" | "confirm" | "status",
	) => {
		const request = context.req.raw;
		const metadata = requestMetadata(request);
		context.header("Cache-Control", "no-store");
		context.header("Referrer-Policy", "no-referrer");
		try {
			if (request.headers.has("authorization"))
				throw new HttpProtocolError(
					"AUTHENTICATION_REQUIRED",
					metadata.traceId,
				);
			if (
				new URL(request.url).search ||
				[
					"x-principal",
					"x-user-id",
					"x-agent-id",
					"x-role",
					"x-principal-id",
				].some((name) => request.headers.has(name))
			)
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			if (
				request.headers.get("origin") !== dependencies.publicOrigin ||
				request.headers.get("x-platform-csrf") !== "1" ||
				(request.headers.has("sec-fetch-site") &&
					request.headers.get("sec-fetch-site") !== "same-origin")
			)
				throw new HttpProtocolError("AUTHORIZATION_REVOKED", metadata.traceId);
			const identity = await resolveIdentity(
				dependencies.identity,
				request,
				metadata.traceId,
			);
			let executionId: string | undefined;
			if (command === "begin")
				executionId = (
					await parseJson(
						request,
						ConnectionInstallationBeginRequestV1Schema,
						metadata.traceId,
					)
				).value.executionId;
			else if (command === "confirm")
				await parseJson(
					request,
					ConnectionInstallationConfirmRequestV1Schema,
					metadata.traceId,
				);
			const authorizationId =
				command === "begin"
					? undefined
					: OpaqueIdV1Schema.parse(context.req.param("authorizationId"));
			const result = await dependencies.installation.execute({
				...metadata,
				userId: identity.userId,
				identityRevision: identity.authorizationRevision,
				command,
				...(executionId ? { executionId } : {}),
				...(authorizationId ? { authorizationId } : {}),
				...(command !== "status"
					? { idempotencyKey: parseIdempotencyKey(request, metadata.traceId) }
					: {}),
			});
			const authorization =
				ConnectionInstallationAuthorizationV1Schema.parse(result);
			return context.json(
				ConnectionInstallationProjectionV1Schema.parse({
					schemaVersion: authorization.schemaVersion,
					authorizationId: authorization.authorizationId,
					status: authorization.status,
					expiresAt: authorization.expiresAt,
				}),
				command === "status" ? 200 : 202,
			);
		} catch (error) {
			const protocol =
				error instanceof HttpProtocolError
					? error
					: new HttpProtocolError(
							error instanceof ConnectionInstallationErrorV1
								? error.code === "denied"
									? "RESOURCE_UNAVAILABLE"
									: error.code === "conflict"
										? "CONFLICT"
										: error.code === "invalid_input"
											? "INVALID_REQUEST"
											: "DEPENDENCY_UNAVAILABLE"
								: "DEPENDENCY_UNAVAILABLE",
							metadata.traceId,
						);
			return context.json(protocol.body, protocol.status);
		}
	};
	app.post("/api/connection-installations", (context) =>
		handle(context, "begin"),
	);
	app.post(
		"/api/connection-installations/:authorizationId/confirm",
		(context) => handle(context, "confirm"),
	);
	app.post("/api/connection-installations/:authorizationId", (context) =>
		handle(context, "status"),
	);
}
