import {
	PersonalRelayKeyReplaceRequestV1Schema,
	PersonalRelayKeyRevokeRequestV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	type createPersonalRelayKeyUseCaseV1,
	PersonalRelayKeyErrorV1,
} from "@agent-infra/platform-core";
import type { Context, Hono } from "hono";

import { HttpProtocolError, parseJson, requestMetadata } from "./common.js";
import { mapCoreError } from "./core-errors.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

export interface PersonalRelayKeyRoutesDependencies {
	readonly identity: IdentityAdapter;
	readonly keys?: ReturnType<typeof createPersonalRelayKeyUseCaseV1>;
}
type PersonalKeys = NonNullable<PersonalRelayKeyRoutesDependencies["keys"]>;

/** The path has no subject ID: a trusted browser session selects its own Key. */
export function registerPersonalRelayKeyRoutes(
	app: Hono,
	dependencies: PersonalRelayKeyRoutesDependencies,
): void {
	async function respond(
		context: Context,
		work: (
			identity: Awaited<ReturnType<typeof resolveIdentity>>,
			metadata: ReturnType<typeof requestMetadata>,
			keys: PersonalKeys,
		) => Promise<unknown>,
	) {
		const metadata = requestMetadata(context.req.raw);
		let actorUserId: string | null = null;
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
			const keys = dependencies.keys;
			if (!keys)
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			return context.json(await work(identity, metadata, keys));
		} catch (error) {
			const protocol = mapCoreError(error, metadata.traceId);
			// A stale version is audited in the same Store transaction as its CAS.
			if (
				!(error instanceof PersonalRelayKeyErrorV1 && error.code === "conflict")
			) {
				try {
					if (!dependencies.keys)
						throw new Error("Personal Relay Key audit is unavailable");
					await dependencies.keys.recordRejected({
						actorUserId,
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
			}
			return context.json(protocol.body, protocol.status);
		}
	}

	app.get("/api/v2/me/relay-key", (context) =>
		respond(context, (identity, metadata, keys) =>
			keys.current(identity, metadata.traceId, metadata.requestId),
		),
	);
	app.put("/api/v2/me/relay-key", (context) =>
		respond(context, async (identity, metadata, keys) => {
			const { value } = await parseJson(
				context.req.raw,
				PersonalRelayKeyReplaceRequestV1Schema,
				metadata.traceId,
			);
			return keys.replace(
				identity,
				value,
				metadata.traceId,
				metadata.requestId,
			);
		}),
	);
	app.delete("/api/v2/me/relay-key", (context) =>
		respond(context, async (identity, metadata, keys) => {
			const { value } = await parseJson(
				context.req.raw,
				PersonalRelayKeyRevokeRequestV1Schema,
				metadata.traceId,
			);
			return keys.revoke(
				identity,
				value.expectedVersion,
				metadata.traceId,
				metadata.requestId,
			);
		}),
	);
}
