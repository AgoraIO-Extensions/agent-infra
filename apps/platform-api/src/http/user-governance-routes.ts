import { PlatformUserDisableCommandV1Schema } from "@agent-infra/contracts/pilot";
import {
	ApiIdentityError,
	type PlatformUserGovernanceUseCaseV1,
} from "@agent-infra/platform-core";
import type { Hono } from "hono";

import { HttpProtocolError, parseJson, requestMetadata } from "./common.js";
import { mapCoreError } from "./core-errors.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

export interface UserGovernanceRoutesDependencies {
	readonly identity: IdentityAdapter;
	readonly governance?: PlatformUserGovernanceUseCaseV1;
}

/** Platform user status is a browser administrator operation. */
export function registerUserGovernanceRoutes(
	app: Hono,
	dependencies: UserGovernanceRoutesDependencies,
): void {
	app.put("/api/v2/admin/users/:userId/disable", async (context) => {
		const metadata = requestMetadata(context.req.raw);
		let actorUserId: string | null = null;
		let targetUserId: string | null = null;
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
			actorUserId = identity.userId;
			if (!dependencies.governance)
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			const requestedUserId = context.req.param("userId");
			targetUserId =
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
					requestedUserId,
				)
					? requestedUserId
					: null;
			dependencies.governance.assertAdministrator(identity.roles);
			if (targetUserId === null)
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			const { value } = await parseJson(
				context.req.raw,
				PlatformUserDisableCommandV1Schema,
				metadata.traceId,
			);
			try {
				await dependencies.governance.setPlatformDisabled({
					actorUserId: identity.userId,
					actorRoles: identity.roles,
					targetUserId,
					disabled: value.disabled,
					traceId: metadata.traceId,
					requestId: metadata.requestId,
				});
			} catch (error) {
				if (error instanceof ApiIdentityError) throw error;
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			}
			return context.body(null, 204);
		} catch (error) {
			const protocol = mapCoreError(error, metadata.traceId);
			try {
				if (!dependencies.governance)
					throw new Error("Governance audit is unavailable");
				await dependencies.governance.recordRejected({
					actorUserId,
					targetUserId,
					traceId: metadata.traceId,
					requestId: metadata.requestId,
					reason: protocol.body.code,
					outcome: protocol.status < 500 ? "rejected" : "failed",
				});
			} catch {
				const unavailable = new HttpProtocolError(
					"DEPENDENCY_UNAVAILABLE",
					metadata.traceId,
				);
				return context.json(unavailable.body, unavailable.status);
			}
			return context.json(protocol.body, protocol.status);
		}
	});
}
