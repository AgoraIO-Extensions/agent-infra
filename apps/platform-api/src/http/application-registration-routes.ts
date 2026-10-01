import {
	ApplicationRegistrationRequestV1Schema,
	ApplicationRegistrationResponseV1Schema,
} from "@agent-infra/contracts/pilot";
import type { ApplicationRegistrationUseCaseV1 } from "@agent-infra/platform-core";
import type { Hono } from "hono";
import {
	HttpProtocolError,
	parseIdempotencyKey,
	parseJson,
	requestMetadata,
} from "./common.js";
import { mapCoreError } from "./core-errors.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

export interface ApplicationRegistrationRouteDependencies {
	readonly identity: IdentityAdapter;
	readonly applications: ApplicationRegistrationUseCaseV1;
}
export function registerApplicationRegistrationRoutes(
	app: Hono,
	dependencies: ApplicationRegistrationRouteDependencies,
): void {
	app.post("/api/v2/applications", async (context) => {
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
			const key = parseIdempotencyKey(request, metadata.traceId);
			const { value } = await parseJson(
				request,
				ApplicationRegistrationRequestV1Schema,
				metadata.traceId,
			);
			submitted = true;
			const result = await dependencies.applications.register(
				trusted,
				key,
				value,
			);
			const response =
				ApplicationRegistrationResponseV1Schema.safeParse(result);
			if (!response.success)
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			return context.json(response.data, result.replayed ? 200 : 201);
		} catch (error) {
			const protocol = mapCoreError(error, metadata.traceId);
			if (!submitted)
				await dependencies.applications.recordRefusal(
					metadata,
					protocol.status === 401
						? "authentication_required"
						: protocol.status === 403
							? "forbidden"
							: protocol.status >= 500
								? "unavailable"
								: "invalid_input",
					userId,
				);
			return context.json(protocol.body, protocol.status);
		}
	});
}
