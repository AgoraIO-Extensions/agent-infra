import { PlatformUserDisableCommandV1Schema } from "@agent-infra/contracts/pilot";
import type { PostgresPlatformUserDisablesV1 } from "@agent-infra/platform-store";
import type { Hono } from "hono";

import { HttpProtocolError, parseJson, requestMetadata } from "./common.js";
import { mapCoreError } from "./core-errors.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

export interface UserGovernanceRoutesDependencies {
	readonly identity: IdentityAdapter;
	readonly users?: Pick<PostgresPlatformUserDisablesV1, "setPlatformDisabled">;
}

const userIdPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Administrator-only browser route for the durable Platform override. */
export function registerUserGovernanceRoutes(
	app: Hono,
	dependencies: UserGovernanceRoutesDependencies,
): void {
	app.put("/api/v2/admin/users/:userId/disable", async (context) => {
		const metadata = requestMetadata(context.req.raw);
		try {
			if (context.req.raw.headers.has("authorization"))
				throw new HttpProtocolError(
					"AUTHENTICATION_REQUIRED",
					metadata.traceId,
				);
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			if (!identity.roles.includes("system_admin"))
				throw new HttpProtocolError("FORBIDDEN", metadata.traceId);
			const targetUserId = context.req.param("userId");
			if (!userIdPattern.test(targetUserId))
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			const { value } = await parseJson(
				context.req.raw,
				PlatformUserDisableCommandV1Schema,
				metadata.traceId,
			);
			if (!dependencies.users)
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			try {
				await dependencies.users.setPlatformDisabled({
					actorUserId: identity.userId,
					targetUserId,
					disabled: value.disabled,
					traceId: metadata.traceId,
					requestId: metadata.requestId,
				});
			} catch (error) {
				if (
					error instanceof Error &&
					error.name === "PlatformUserDisableError" &&
					typeof (error as { code?: unknown }).code === "string"
				) {
					const code = (error as { code?: unknown }).code;
					throw new HttpProtocolError(
						code === "not_authorized"
							? "FORBIDDEN"
							: code === "resource_unavailable"
								? "RESOURCE_UNAVAILABLE"
								: code === "invalid_input"
									? "INVALID_REQUEST"
									: "DEPENDENCY_UNAVAILABLE",
						metadata.traceId,
					);
				}
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			}
			return context.body(null, 204);
		} catch (error) {
			const protocol = mapCoreError(error, metadata.traceId);
			return context.json(protocol.body, protocol.status);
		}
	});
}
