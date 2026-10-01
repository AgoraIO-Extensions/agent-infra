import {
	PersonalRelayKeyReplaceRequestV1Schema,
	PersonalRelayKeyRevokeRequestV1Schema,
	PersonalRelayKeyStateV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	type createPersonalRelayKeyUseCaseV1,
	PersonalRelayKeyErrorV1,
	type PersonalRelayKeyOperationV1,
} from "@agent-infra/platform-core";
import type { Context, Hono } from "hono";
import { HttpProtocolError, parseJson, requestMetadata } from "./common.js";
import { mapCoreError } from "./core-errors.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

export interface PersonalRelayKeyRoutesDependencies {
	readonly identity: IdentityAdapter;
	readonly keys: ReturnType<typeof createPersonalRelayKeyUseCaseV1>;
}

export function registerPersonalRelayKeyRoutes(
	app: Hono,
	dependencies: PersonalRelayKeyRoutesDependencies,
): void {
	async function handle(
		context: Context,
		operation: PersonalRelayKeyOperationV1,
	): Promise<Response> {
		const request = context.req.raw;
		const metadata = requestMetadata(request);
		let userId: string | null = null;
		let submitted = false;
		context.header("Cache-Control", "no-store");
		context.header("Referrer-Policy", "no-referrer");
		try {
			if (request.headers.has("Authorization"))
				throw new HttpProtocolError(
					"AUTHENTICATION_REQUIRED",
					metadata.traceId,
				);
			if (new URL(request.url).search !== "")
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			const identity = await resolveIdentity(
				dependencies.identity,
				request,
				metadata.traceId,
			);
			userId = identity.userId;
			const trusted = { ...metadata, userId };
			let result: unknown;
			if (operation === "read") {
				// GET bodies are not accepted, including direct invocation through a Request.
				if (request.body !== null)
					throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
				submitted = true;
				result = await dependencies.keys.current(trusted);
			} else if (operation === "replace") {
				const { value } = await parseJson(
					request,
					PersonalRelayKeyReplaceRequestV1Schema,
					metadata.traceId,
				);
				submitted = true;
				result = await dependencies.keys.replace(trusted, value);
			} else {
				const { value } = await parseJson(
					request,
					PersonalRelayKeyRevokeRequestV1Schema,
					metadata.traceId,
				);
				submitted = true;
				result = await dependencies.keys.revoke(trusted, value);
			}
			const response = PersonalRelayKeyStateV1Schema.safeParse(result);
			if (!response.success)
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			return context.json(response.data, 200);
		} catch (error) {
			const protocol = mapCoreError(error, metadata.traceId);
			if (!submitted) {
				try {
					await dependencies.keys.recordRefusal(
						metadata,
						operation,
						error instanceof PersonalRelayKeyErrorV1
							? error.code
							: protocol.status === 401
								? "authentication_required"
								: protocol.status === 403
									? "not_authorized"
									: protocol.status >= 500
										? "unavailable"
										: "invalid_input",
						userId,
					);
				} catch {
					const unavailable = new HttpProtocolError(
						"DEPENDENCY_UNAVAILABLE",
						metadata.traceId,
					);
					return context.json(unavailable.body, unavailable.status);
				}
			}
			return context.json(protocol.body, protocol.status);
		}
	}
	app.get("/api/v2/me/relay-key", (context) => handle(context, "read"));
	app.put("/api/v2/me/relay-key", (context) => handle(context, "replace"));
	app.delete("/api/v2/me/relay-key", (context) => handle(context, "revoke"));
}
