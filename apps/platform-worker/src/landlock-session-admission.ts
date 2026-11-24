import { createHash } from "node:crypto";

export interface LandlockSessionScopeV1 {
	readonly principalDigest: string;
	readonly channelId: string;
	readonly agentId: string;
	readonly sessionId: string;
	readonly sandboxId: string;
	readonly namespace: string;
	readonly generation: number;
	readonly resourceFence: number;
	readonly imageDigest: string;
	readonly resourceConfigurationHash: string;
	readonly driver: "claude" | "acp" | "pi";
}
export interface LandlockSessionAdmissionV1 {
	readonly enabled: true;
	readonly revision: string;
	/** Deployment-owned verifier: validates current node UID, kernel/LSM/CRI support,
	 * exact policy hash, per-node network/isolation proof and approval expiry.
	 * It must read authoritative sources; Owner/Runtime replies cannot grant placement. */
	readonly verify: (scope: LandlockSessionScopeV1) => Promise<{
		readonly scope: LandlockSessionScopeV1;
		readonly approvalRef: string;
		readonly expiresAt: number;
		readonly nodeNames: readonly string[];
		readonly architecture: "amd64" | "arm64";
	}>;
}
export interface LandlockSessionProjectionV1 {
	readonly approvalRef: string;
	readonly digest: string;
	readonly nodeNames: readonly string[];
	readonly architecture: "amd64" | "arm64";
}
const issued = new WeakMap<object, () => boolean>();
export async function admitLandlockSessionV1(
	policy: LandlockSessionAdmissionV1 | undefined,
	scope: LandlockSessionScopeV1,
	now = Date.now,
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
		!scope.sandboxId
	)
		throw new Error("LANDLOCK_SESSION_SCOPE_REJECTED");
	const result = await policy.verify(Object.freeze({ ...scope }));
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
	const projection = Object.freeze({
		approvalRef: result.approvalRef,
		digest: createHash("sha256")
			.update(
				JSON.stringify({
					scope,
					approvalRef: result.approvalRef,
					architecture: result.architecture,
					nodeNames: [...result.nodeNames].sort(),
				}),
			)
			.digest("hex"),
		nodeNames: Object.freeze([...result.nodeNames].sort()),
		architecture: result.architecture,
	});
	issued.set(projection, () => result.expiresAt > now());
	return projection;
}
export function landlockSessionPodPlacementV1(
	projection: LandlockSessionProjectionV1,
) {
	if (issued.get(projection)?.() !== true)
		throw new Error("LANDLOCK_SESSION_EVIDENCE_REJECTED");
	return {
		nodeSelector: { "kubernetes.io/arch": projection.architecture },
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
