import { OpaqueIdV1Schema } from "@agent-infra/contracts";
import {
	PersonalApiCredentialIssueRequestV1Schema,
	PersonalApiCredentialIssueResponseV1Schema,
	PersonalApiCredentialRevokeResponseV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	PersonalApiCredentialErrorV1,
	type PersonalApiCredentialMutationV1,
	type PersonalApiCredentialUseCaseV1,
} from "@agent-infra/platform-core";
import type { Context, Hono } from "hono";
import {
	HttpProtocolError,
	parseIdempotencyKey,
	parseJson,
	requestMetadata,
} from "./common.js";
import { mapCoreError } from "./core-errors.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

export interface PersonalApiCredentialRouteDependencies {
	readonly identity: IdentityAdapter;
	readonly credentials: PersonalApiCredentialUseCaseV1;
}

async function requireEmptyBody(
	request: Request,
	traceId: string,
): Promise<void> {
	const reader = request.body?.getReader();
	if (!reader) return;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			if (value.byteLength > 0) {
				await reader.cancel().catch(() => {});
				throw new Error();
			}
		}
	} catch {
		throw new HttpProtocolError("INVALID_REQUEST", traceId);
	} finally {
		reader.releaseLock();
	}
}

export function registerPersonalApiCredentialRoutes(
	app: Hono,
	dependencies: PersonalApiCredentialRouteDependencies,
): void {
	async function handle(
		context: Context,
		operation: PersonalApiCredentialMutationV1,
	): Promise<Response> {
		const request = context.req.raw;
		const metadata = requestMetadata(request);
		let submitted = false;
		let trustedUserId: string | undefined;
		context.header("Cache-Control", "no-store");
		context.header("Referrer-Policy", "no-referrer");
		try {
			if (request.headers.has("Authorization")) {
				throw new HttpProtocolError(
					"AUTHENTICATION_REQUIRED",
					metadata.traceId,
				);
			}
			if (new URL(request.url).search !== "") {
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			}
			const identity = await resolveIdentity(
				dependencies.identity,
				request,
				metadata.traceId,
			);
			trustedUserId = identity.userId;
			const trusted = {
				...metadata,
				userId: identity.userId,
				idempotencyKey: parseIdempotencyKey(request, metadata.traceId),
			};
			if (operation === "api.credential.issued") {
				const { value } = await parseJson(
					request,
					PersonalApiCredentialIssueRequestV1Schema,
					metadata.traceId,
				);
				submitted = true;
				const result = await dependencies.credentials.issue(trusted, value);
				const response =
					PersonalApiCredentialIssueResponseV1Schema.safeParse(result);
				if (!response.success)
					throw new HttpProtocolError(
						"DEPENDENCY_UNAVAILABLE",
						metadata.traceId,
					);
				return context.json(response.data, result.replayed ? 200 : 201);
			}
			const credentialId = OpaqueIdV1Schema.safeParse(
				context.req.param("credentialId"),
			);
			if (!credentialId.success) {
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			}
			await requireEmptyBody(request, metadata.traceId);
			submitted = true;
			const result = await dependencies.credentials.revoke(
				trusted,
				credentialId.data,
			);
			const response =
				PersonalApiCredentialRevokeResponseV1Schema.safeParse(result);
			if (!response.success)
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			return context.json(response.data, 200);
		} catch (error) {
			const protocol = mapCoreError(error, metadata.traceId);
			if (!submitted) {
				const reason =
					error instanceof PersonalApiCredentialErrorV1
						? error.code
						: protocol.status === 401
							? "authentication_required"
							: protocol.status === 403
								? "forbidden"
								: protocol.status >= 500
									? "unavailable"
									: "invalid_input";
				try {
					await dependencies.credentials.recordRefusal(
						metadata,
						operation,
						reason,
						trustedUserId,
					);
				} catch {
					/* The original refusal remains a refusal. */
				}
			}
			return context.json(protocol.body, protocol.status);
		}
	}
	app.post("/api/v2/me/api-credentials", (context) =>
		handle(context, "api.credential.issued"),
	);
	app.delete("/api/v2/me/api-credentials/:credentialId", (context) =>
		handle(context, "api.credential.revoked"),
	);
}
