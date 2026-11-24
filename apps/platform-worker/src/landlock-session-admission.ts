import { isDeepStrictEqual } from "node:util";

import {
	type LandlockSessionPlacementV1,
	LandlockSessionPlacementV1Schema,
	type LandlockSessionScopeV1,
	LandlockSessionScopeV1Schema,
} from "@agent-infra/contracts/runtime";

export type { LandlockSessionScopeV1 } from "@agent-infra/contracts/runtime";

export interface LandlockSessionAdmissionV1 {
	readonly enabled: true;
	readonly revision: string;
	/** Deployment-owned verifier: validates current node UID, kernel/LSM/CRI support,
	 * exact policy hash, managed pool label/taint, per-node network/isolation proof and approval expiry.
	 * It must read authoritative sources; Owner/Runtime replies cannot grant placement. */
	readonly verify: (
		scope: LandlockSessionScopeV1,
		original?: LandlockSessionPlacementV1,
	) => Promise<{
		readonly scope: LandlockSessionScopeV1;
		readonly approvalRef: string;
		readonly expiresAt: number;
		readonly nodeNames: readonly string[];
		readonly nodeUids: readonly string[];
		readonly architecture: "amd64" | "arm64";
	}>;
}
export type LandlockSessionProjectionV1 = LandlockSessionPlacementV1;
const issued = new WeakMap<object, { create: () => boolean }>();
export const landlockSessionPoolLabelV1 = "agent-infra.agora.io/native-shell";
export const landlockSessionPoolValueV1 = "landlock-v5";
function freezePlacement(plan: LandlockSessionPlacementV1) {
	Object.freeze(plan.scope);
	Object.freeze(plan.nodeNames);
	Object.freeze(plan.nodeUids);
	Object.freeze(plan);
	return plan;
}
export function restoreLandlockSessionV1(
	recorded: unknown,
	scope: LandlockSessionScopeV1,
): LandlockSessionProjectionV1 {
	const plan = LandlockSessionPlacementV1Schema.parse(recorded);
	if (!isDeepStrictEqual(plan.scope, LandlockSessionScopeV1Schema.parse(scope)))
		throw new Error("LANDLOCK_SESSION_SCOPE_REJECTED");
	issued.set(plan, { create: () => false });
	return freezePlacement(plan);
}
export function assertLandlockSessionCreationV1(
	plan: LandlockSessionProjectionV1,
) {
	if (issued.get(plan)?.create() !== true)
		throw new Error("LANDLOCK_SESSION_EVIDENCE_REJECTED");
}
export async function admitLandlockSessionV1(
	policy: LandlockSessionAdmissionV1 | undefined,
	scope: LandlockSessionScopeV1,
	now = Date.now,
	original?: LandlockSessionPlacementV1,
): Promise<LandlockSessionProjectionV1 | undefined> {
	if (policy === undefined) return undefined;
	if (
		policy.enabled !== true ||
		typeof policy.verify !== "function" ||
		!["claude", "acp", "pi"].includes(scope.driver) ||
		![scope.generation, scope.resourceFence].every(
			(v) => Number.isSafeInteger(v) && v > 0,
		) ||
		!scope.agentId ||
		!scope.sessionId ||
		!scope.sandboxId ||
		!LandlockSessionScopeV1Schema.safeParse(scope).success
	)
		throw new Error("LANDLOCK_SESSION_SCOPE_REJECTED");
	const result = await policy.verify(Object.freeze({ ...scope }), original);
	if (
		!result ||
		Object.keys(scope).some(
			(k) =>
				scope[k as keyof typeof scope] !==
				result.scope?.[k as keyof typeof scope],
		) ||
		Object.keys(result.scope).length !== Object.keys(scope).length
	)
		throw new Error("LANDLOCK_SESSION_SCOPE_REJECTED");
	if (
		!/^[A-Za-z0-9._:-]{1,128}$/.test(result.approvalRef) ||
		!Number.isSafeInteger(result.expiresAt) ||
		result.expiresAt <= now() ||
		result.expiresAt - now() > 60_000 ||
		!["amd64", "arm64"].includes(result.architecture) ||
		!Array.isArray(result.nodeNames) ||
		result.nodeNames.length === 0 ||
		result.nodeNames.length > 64 ||
		new Set(result.nodeNames).size !== result.nodeNames.length ||
		result.nodeNames.some(
			(n) => !/^([a-z0-9]([-a-z0-9.]*[a-z0-9])?)$/.test(n) || n.length > 253,
		)
	)
		throw new Error("LANDLOCK_SESSION_EVIDENCE_REJECTED");
	const projection = LandlockSessionPlacementV1Schema.parse({
		schemaVersion: 1,
		revision: original?.revision ?? policy.revision,
		scope,
		approvalRef: original?.approvalRef ?? result.approvalRef,
		architecture: result.architecture,
		nodeNames: [...result.nodeNames],
		nodeUids: [...result.nodeUids],
	});
	if (
		original &&
		!isDeepStrictEqual(
			LandlockSessionPlacementV1Schema.parse(original),
			projection,
		)
	)
		throw new Error("LANDLOCK_SESSION_PLACEMENT_CHANGED");
	const expiresAt = result.expiresAt;
	issued.set(projection, { create: () => expiresAt > now() });
	return freezePlacement(projection);
}
export function landlockSessionPodPlacementV1(
	projection: LandlockSessionProjectionV1,
) {
	if (!issued.has(projection))
		throw new Error("LANDLOCK_SESSION_EVIDENCE_REJECTED");
	return {
		nodeSelector: {
			"kubernetes.io/arch": projection.architecture,
			[landlockSessionPoolLabelV1]: landlockSessionPoolValueV1,
		},
		tolerations: [
			{
				key: landlockSessionPoolLabelV1,
				operator: "Equal",
				value: landlockSessionPoolValueV1,
				effect: "NoSchedule",
			},
		],
		affinity: {
			nodeAffinity: {
				requiredDuringSchedulingIgnoredDuringExecution: {
					nodeSelectorTerms: [
						{
							matchFields: [
								{
									key: "metadata.name",
									operator: "In",
									values: [...projection.nodeNames],
								},
							],
						},
					],
				},
			},
		},
	};
}
