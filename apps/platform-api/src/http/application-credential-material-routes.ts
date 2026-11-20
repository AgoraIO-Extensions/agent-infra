import { OpaqueIdV1Schema } from "@agent-infra/contracts";
import {
	ApplicationCredentialMaterialConfirmV1Schema,
	ApplicationCredentialMaterialIntentV1Schema,
	ApplicationCredentialMaterialMetadataV1Schema,
	ApplicationCredentialMaterialReceiveV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	ApplicationApiCredentialErrorV1,
	type createApplicationCredentialMaterialDeliveryV1,
} from "@agent-infra/platform-core";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type { Hono } from "hono";
import { applicationCredentialMaterialResponseV1 } from "./application-credential-material-response.js";
import {
	HttpProtocolError,
	parseIdempotencyKey,
	parseJson,
	requestMetadata,
} from "./common.js";
import { mapCoreError } from "./core-errors.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

export interface ApplicationCredentialMaterialRouteDependenciesV1 {
	readonly identity: IdentityAdapter;
	readonly delivery: ReturnType<
		typeof createApplicationCredentialMaterialDeliveryV1
	>;
}
export function registerApplicationCredentialMaterialRoutesV1(
	app: Hono,
	input: ApplicationCredentialMaterialRouteDependenciesV1,
) {
	app.post(
		"/api/v2/applications/:applicationId/credential-material-deliveries",
		async (context) => {
			const request = context.req.raw;
			const metadata = requestMetadata(request);
			context.header("Cache-Control", "no-store");
			context.header("Referrer-Policy", "no-referrer");
			try {
				if (request.headers.has("Authorization"))
					throw new HttpProtocolError(
						"AUTHENTICATION_REQUIRED",
						metadata.traceId,
					);
				const identity = await resolveIdentity(
					input.identity,
					request,
					metadata.traceId,
				);
				if (!input.delivery.publicOrigin)
					throw new HttpProtocolError(
						"DEPENDENCY_UNAVAILABLE",
						metadata.traceId,
					);
				if (request.headers.get("Origin") !== input.delivery.publicOrigin)
					throw new HttpProtocolError("FORBIDDEN", metadata.traceId);
				const applicationId = OpaqueIdV1Schema.safeParse(
					context.req.param("applicationId"),
				);
				const parsed = {
					success: true as const,
					data: (
						await parseJson(
							request,
							ApplicationCredentialMaterialIntentV1Schema,
							metadata.traceId,
						)
					).value,
				};
				if (
					!applicationId.success ||
					!parsed.success ||
					new URL(request.url).search
				)
					throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
				const { schemaVersion: _version, ...command } = parsed.data;
				const result = await input.delivery.prepare(
					{
						...metadata,
						applicationId: applicationId.data,
						userId: identity.userId,
						idempotencyKey: parseIdempotencyKey(request, metadata.traceId),
					},
					command,
				);
				const response =
					ApplicationCredentialMaterialMetadataV1Schema.parse(result);
				return context.json(response, result.replayed ? 200 : 201);
			} catch (error) {
				const mapped =
					error instanceof ApplicationApiCredentialErrorV1
						? new HttpProtocolError(
								(
									{
										invalid_input: "INVALID_REQUEST",
										forbidden: "AUTHORIZATION_REVOKED",
										not_found: "RESOURCE_UNAVAILABLE",
										idempotency_conflict: "CONFLICT",
										unavailable: "DEPENDENCY_UNAVAILABLE",
									} as const
								)[error.code],
								metadata.traceId,
							)
						: error;
				throw mapCoreError(mapped, metadata.traceId);
			}
		},
	);
	const path =
		"/api/v2/applications/:applicationId/credential-material-deliveries/:attemptId";
	for (const operation of ["read", "receive", "confirm"] as const) {
		app.on(
			operation === "read" ? "GET" : "POST",
			operation === "read" ? path : `${path}/${operation}`,
			async (context) => {
				const request = context.req.raw;
				const metadata = requestMetadata(request);
				context.header("Cache-Control", "no-store");
				context.header("Referrer-Policy", "no-referrer");
				let transport:
					| ReturnType<typeof applicationCredentialMaterialResponseV1>
					| undefined;
				try {
					if (request.headers.has("Authorization"))
						throw new HttpProtocolError(
							"AUTHENTICATION_REQUIRED",
							metadata.traceId,
						);
					const identity = await resolveIdentity(
						input.identity,
						request,
						metadata.traceId,
					);
					if (operation !== "read" && !input.delivery.publicOrigin)
						throw new HttpProtocolError(
							"DEPENDENCY_UNAVAILABLE",
							metadata.traceId,
						);
					if (
						operation !== "read" &&
						request.headers.get("Origin") !== input.delivery.publicOrigin
					)
						throw new HttpProtocolError("FORBIDDEN", metadata.traceId);
					const applicationId = OpaqueIdV1Schema.safeParse(
						context.req.param("applicationId"),
					);
					const attemptId = OpaqueIdV1Schema.safeParse(
						context.req.param("attemptId"),
					);
					if (
						!applicationId.success ||
						!attemptId.success ||
						new URL(request.url).search
					)
						throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
					const trusted = {
						...metadata,
						userId: identity.userId,
						applicationId: applicationId.data,
						attemptId: attemptId.data,
						signal: request.signal,
					};
					if (operation === "read")
						return context.json(
							ApplicationCredentialMaterialMetadataV1Schema.parse(
								await input.delivery.read(trusted),
							),
						);
					if (operation === "confirm") {
						const { value } = await parseJson(
							request,
							ApplicationCredentialMaterialConfirmV1Schema,
							metadata.traceId,
						);
						return context.json(
							ApplicationCredentialMaterialMetadataV1Schema.parse(
								await input.delivery.confirm(trusted, value),
							),
						);
					}
					await parseJson(
						request,
						ApplicationCredentialMaterialReceiveV1Schema,
						metadata.traceId,
					);
					try {
						transport = applicationCredentialMaterialResponseV1(
							context.env,
							request,
						);
					} catch {
						throw new HttpProtocolError(
							"DEPENDENCY_UNAVAILABLE",
							metadata.traceId,
						);
					}
					const writer = transport;
					const result = await input.delivery.receive(
						trusted,
						async (material, delivery, signal) => {
							const current = await resolveIdentity(
								input.identity,
								request,
								metadata.traceId,
							);
							if (
								current.userId !== identity.userId ||
								current.authorizationRevision !== identity.authorizationRevision
							)
								throw new ApplicationApiCredentialErrorV1("forbidden");
							await writer.write(material, delivery, signal);
						},
					);
					if (transport.sent) return RESPONSE_ALREADY_SENT;
					return context.json({
						schemaVersion: 1 as const,
						kind: "metadata" as const,
						delivery:
							ApplicationCredentialMaterialMetadataV1Schema.parse(result),
					});
				} catch (error) {
					if (transport?.sent) {
						transport.abort();
						return RESPONSE_ALREADY_SENT;
					}
					const mapped =
						error instanceof ApplicationApiCredentialErrorV1
							? new HttpProtocolError(
									(
										{
											invalid_input: "INVALID_REQUEST",
											forbidden: "AUTHORIZATION_REVOKED",
											not_found: "RESOURCE_UNAVAILABLE",
											idempotency_conflict: "CONFLICT",
											unavailable: "DEPENDENCY_UNAVAILABLE",
										} as const
									)[error.code],
									metadata.traceId,
								)
							: error;
					throw mapCoreError(mapped, metadata.traceId);
				}
			},
		);
	}
}
