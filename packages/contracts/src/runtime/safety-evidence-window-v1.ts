import { z } from "zod";

import {
	OpaqueCursorV1Schema,
	OpaqueIdV1Schema,
	Rfc3339TimestampV1Schema,
} from "../common.ts";
import {
	RuntimeIsolationActionClassV1Schema,
	RuntimeIsolationResourceClassV1Schema,
} from "./safety-evidence-v1.ts";

/**
 * Engineering Spec §18.5.1 验收场景: the deployment-injected, default-off acceptance window.
 * Absent configuration means no window; it never grants read, execution or business access.
 * The same document is injected into the Worker and into the Hosts that may produce evidence.
 */
const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const positive = z.number().int().positive().safe();

/** Longest window a deployment may open at once (a bounded acceptance window, not a mode). */
export const runtimeSafetyEvidenceWindowMaxDurationMsV1 = 72 * 60 * 60 * 1000;

const unique = <T>(values: readonly T[], key: (value: T) => string) =>
	new Set(values.map(key)).size === values.length;

export const RuntimeSafetyEvidenceWindowV1Schema = z
	.strictObject({
		schemaVersion: z.literal(1),
		windowRef: reference,
		opensAt: Rfc3339TimestampV1Schema,
		closesAt: Rfc3339TimestampV1Schema,
		agentIds: z.array(OpaqueIdV1Schema.max(128)).min(1).max(16),
		/** `runtimeSafetyEvidencePrincipalRefV1` of each approved test subject. */
		principalRefs: z.array(reference).min(1).max(16),
		scenarios: z
			.array(
				z.strictObject({
					id: reference,
					version: positive,
					resourceClasses: z
						.array(RuntimeIsolationResourceClassV1Schema)
						.min(1)
						.max(6),
					actionClasses: z
						.array(RuntimeIsolationActionClassV1Schema)
						.min(1)
						.max(7),
				}),
			)
			.min(1)
			.max(32),
		producers: z
			.array(
				z.strictObject({
					kind: z.enum(["native_helper", "model_transport"]),
					version: reference,
				}),
			)
			.min(1)
			.max(8),
	})
	.superRefine((value, context) => {
		const opens = Date.parse(value.opensAt);
		const closes = Date.parse(value.closesAt);
		if (
			!(closes > opens) ||
			closes - opens > runtimeSafetyEvidenceWindowMaxDurationMsV1
		)
			context.addIssue({
				code: "custom",
				message: "the window closes after it opens and stays bounded",
			});
		if (
			!unique(value.agentIds, (id) => id) ||
			!unique(value.principalRefs, (ref) => ref) ||
			!unique(value.scenarios, (entry) => `${entry.id}@${entry.version}`) ||
			!unique(value.producers, (entry) => `${entry.kind}@${entry.version}`)
		)
			context.addIssue({
				code: "custom",
				message: "window members are listed once",
			});
	});
export type RuntimeSafetyEvidenceWindowV1 = z.infer<
	typeof RuntimeSafetyEvidenceWindowV1Schema
>;

/** Host evidence log ACK receipt: the cursor the Host has durably recorded as confirmed. */
export const RuntimeSafetyEvidenceLogAckResponseV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	acknowledged: OpaqueCursorV1Schema,
});

/**
 * The binding's `purposeRef` is the original Grant purpose. Evidence is produced only for a
 * business execution; control (stop, revocation) never creates a new purpose for it.
 */
export const runtimeSafetyEvidenceBusinessPurposeRefV1 = "business";

/**
 * The binding's `principalRef`: a fixed pseudonymous reference of the original subject, so the
 * window and the technical binding never carry the raw subject id. Producers and the Worker
 * derive it the same way; it is not a capability.
 */
export async function runtimeSafetyEvidencePrincipalRefV1(principal: {
	readonly kind: "user" | "application";
	readonly id: string;
}): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			`agent-infra/runtime-safety-evidence/principal/v1\n${principal.kind}\n${principal.id}`,
		),
	);
	return `p1-${Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("")}`;
}
