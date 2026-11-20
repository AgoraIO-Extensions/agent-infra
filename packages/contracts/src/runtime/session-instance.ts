import { z } from "zod";
import { OpaqueIdV1Schema } from "../index.ts";
import { canonicalRuntimeRequestSigningPayload } from "./request-signing.ts";

const positive = z.number().int().positive().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const compact = z
	.string()
	.max(32_768)
	.regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
export const sessionInstanceReadPathV1 =
	"/internal/runtime/v1/session-instance/read";
export const SessionInstanceReadScopeV1Schema = z.discriminatedUnion("phase", [
	z.strictObject({
		phase: z.literal("reserve"),
		reserveRef: OpaqueIdV1Schema,
		reserveDeliveryFence: positive,
	}),
	z.strictObject({
		phase: z.literal("claimed"),
		claimRef: OpaqueIdV1Schema,
		allocationRef: OpaqueIdV1Schema,
	}),
]);
export const SessionInstanceReadBodyV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	requestId: OpaqueIdV1Schema,
	traceId: OpaqueIdV1Schema,
	nonce: z
		.string()
		.min(22)
		.max(128)
		.regex(/^[A-Za-z0-9_-]+$/),
	workerId: OpaqueIdV1Schema,
	namespace: OpaqueIdV1Schema,
	agentId: OpaqueIdV1Schema,
	sessionId: OpaqueIdV1Schema,
	sandboxId: OpaqueIdV1Schema,
	podUid: OpaqueIdV1Schema,
	generation: positive,
	resourceFence: positive,
	startupRef: OpaqueIdV1Schema,
	bindingDigest: digest,
	profileDigest: digest,
	scope: SessionInstanceReadScopeV1Schema,
});
export type SessionInstanceReadBodyV1 = z.infer<
	typeof SessionInstanceReadBodyV1Schema
>;
export const SessionInstanceReadRequestV1Schema =
	SessionInstanceReadBodyV1Schema.extend({ authorization: compact });
export const SessionInstanceReadClaimsV1Schema = z.strictObject({
	issuer: OpaqueIdV1Schema,
	audience: z.literal("runtime_host_session_instance"),
	purpose: z.literal("session-instance-read-v1"),
	workerId: OpaqueIdV1Schema,
	issuedAt: positive,
	expiresAt: positive,
	requestDigest: digest,
});
export const SessionInstanceEvidenceBodyV1Schema =
	SessionInstanceReadBodyV1Schema.extend({
		requestDigest: digest,
		hostKeyId: OpaqueIdV1Schema,
		runnerEpoch: z.string().uuid(),
		observedAt: positive,
		expiresAt: positive,
		checks: z.strictObject({
			hostIdentityConsumed: z.literal(true),
			runnerIdentityConsumed: z.literal(true),
			deliveryFilesRemoved: z.literal(true),
			executorReady: z.literal(true),
			emptyBusinessState: z.literal(true),
		}),
	});
export const SessionInstanceEvidenceV1Schema =
	SessionInstanceEvidenceBodyV1Schema.extend({ signature: compact });
export const SessionInstanceEvidenceClaimsV1Schema =
	SessionInstanceEvidenceBodyV1Schema.extend({
		purpose: z.literal("session-instance-evidence-v1"),
		audience: OpaqueIdV1Schema,
	});
export function sessionInstanceReadSigningPayloadV1(input: unknown) {
	const body = SessionInstanceReadBodyV1Schema.parse(input);
	return JSON.stringify([
		1,
		"POST",
		sessionInstanceReadPathV1,
		JSON.parse(
			canonicalRuntimeRequestSigningPayload({ grant: undefined, ...body }),
		),
	]);
}
/** Bounded wire callers own size/UTF-8 checks; syntax and duplicate keys never get normalized away. */
export function parseSessionInstanceJsonV1(text: string): unknown {
	const result: unknown = JSON.parse(text);
	const objects: (Set<string> | undefined)[] = [];
	for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]]/g)) {
		const token = match[0];
		if (token === "{") objects.push(new Set());
		else if (token === "[") objects.push(undefined);
		else if (token === "}" || token === "]") objects.pop();
		else if (/^\s*:/.test(text.slice(match.index + token.length))) {
			const keys = objects.at(-1);
			const key: string = JSON.parse(token);
			if (!keys || keys.has(key))
				throw new Error("SESSION_INSTANCE_JSON_INVALID");
			keys.add(key);
		}
	}
	return result;
}
