import { OpaqueIdV1Schema } from "@agent-infra/contracts";
import {
	ApplicationApiCredentialRequestV1Schema,
	ApplicationApiCredentialResponseV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	ApplicationApiCredentialErrorV1,
	type createApplicationApiCredentialIssuerV1,
} from "@agent-infra/platform-core";
import type { Hono } from "hono";
import {
	HttpProtocolError,
	parseIdempotencyKey,
	parseJson,
	requestMetadata,
} from "./common.js";
import { mapCoreError } from "./core-errors.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

export function registerApplicationApiCredentialRoutes(
	app: Hono,
	input: {
		readonly identity: IdentityAdapter;
		readonly issuer: ReturnType<typeof createApplicationApiCredentialIssuerV1>;
	},
): void {
	app.post(
		"/api/v2/applications/:applicationId/credentials",
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
				if (new URL(request.url).search)
					throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
				const identity = await resolveIdentity(
					input.identity,
					request,
					metadata.traceId,
				);
				const applicationId = OpaqueIdV1Schema.safeParse(
					context.req.param("applicationId"),
				);
				if (!applicationId.success)
					throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
				const idempotencyKey = parseIdempotencyKey(request, metadata.traceId);
				const { value } = await parseJson(
					request,
					ApplicationApiCredentialRequestV1Schema,
					metadata.traceId,
				);
				const result = await input.issuer.execute(
					{
						...metadata,
						applicationId: applicationId.data,
						userId: identity.userId,
						idempotencyKey,
					},
					value,
				);
				const response =
					ApplicationApiCredentialResponseV1Schema.safeParse(result);
				if (!response.success)
					throw new HttpProtocolError(
						"DEPENDENCY_UNAVAILABLE",
						metadata.traceId,
					);
				return context.json(response.data, result.replayed ? 200 : 201);
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
				const protocol = mapCoreError(mapped, metadata.traceId);
				return context.json(protocol.body, protocol.status);
			}
		},
	);
}

/** The trusted application process supplies its own typed identity and synchronous
 * acceptance callback at assembly time. A request cannot choose this destination.
 * This adapter only supports an in-process consumer; it is not a network delivery queue.
 */
export function createApplicationCredentialProcessDeliveryV1(consumer: {
	readonly principalType: "user" | "application";
	readonly principalId: string;
	readonly accept: (attemptId: string, material: string) => boolean;
}): import("@agent-infra/platform-core").ApplicationCredentialDeliveryPortV1 {
	const pending = new Map<
		string,
		{ material: string; binding: string; timer: ReturnType<typeof setTimeout> }
	>();
	const binding = (
		attempt: import("@agent-infra/platform-core").ApplicationCredentialAttemptV1,
	) => JSON.stringify(attempt);
	const abort = (
		attempt: import("@agent-infra/platform-core").ApplicationCredentialAttemptV1,
	) => {
		const saved = pending.get(attempt.attemptId);
		if (saved) clearTimeout(saved.timer);
		pending.delete(attempt.attemptId);
	};
	return {
		async prepare(attempt, material, signal) {
			signal.throwIfAborted();
			if (
				attempt.recipient.principalType !== consumer.principalType ||
				attempt.recipient.principalId !== consumer.principalId ||
				Date.now() >= Date.parse(attempt.expiresAt) ||
				pending.has(attempt.attemptId)
			)
				throw new Error("Delivery unavailable");
			const timer = setTimeout(
				() => abort(attempt),
				Math.max(0, Date.parse(attempt.expiresAt) - Date.now()),
			);
			timer.unref();
			pending.set(attempt.attemptId, {
				material,
				binding: binding(attempt),
				timer,
			});
		},
		async commit(attempt, signal) {
			signal.throwIfAborted();
			const saved = pending.get(attempt.attemptId);
			if (
				!saved ||
				saved.binding !== binding(attempt) ||
				Date.now() >= Date.parse(attempt.expiresAt)
			) {
				abort(attempt);
				throw new Error("Delivery unavailable");
			}
			// No await exists between fencing, discarding our copy, and recipient acceptance.
			abort(attempt);
			return consumer.accept(attempt.attemptId, saved.material) === true
				? "accepted"
				: "unknown";
		},
		abort,
	};
}
