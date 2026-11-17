/** Deployment-only retention policy; no user deletion capability. */
export interface SessionWorkspaceRetentionPolicyV1 {
	readonly namespace: string;
	readonly minimumStoppedMs: number;
	readonly retainedAgentIds: readonly string[];
	readonly retainedSessionIds: readonly string[];
	readonly retainedSandboxIds: readonly string[];
}
export interface SessionWorkspaceReclamationTargetV1 {
	readonly sessionGeneration: number;
	readonly resourceFence: number;
	readonly agentId: string;
	readonly sessionId: string;
	readonly sandboxId: string;
	readonly namespace: string;
	readonly name: string;
	readonly uid: string;
	readonly resourceVersion: string;
}
export function validateWorkspaceRetentionPolicyV1(
	p: SessionWorkspaceRetentionPolicyV1,
) {
	if (
		!/^[a-z0-9][-a-z0-9]{0,62}$/.test(p.namespace) ||
		!Number.isSafeInteger(p.minimumStoppedMs) ||
		p.minimumStoppedMs < 1 ||
		![p.retainedAgentIds, p.retainedSessionIds, p.retainedSandboxIds].every(
			(a) =>
				Array.isArray(a) &&
				a.every((id) => typeof id === "string" && id.length > 0),
		)
	)
		throw new Error("WORKSPACE_RETENTION_POLICY_INVALID");
}
/** Conservative protection for named acceptance samples, including truncated historical IDs. */
export function isWorkspaceRetainedV1(
	p: SessionWorkspaceRetentionPolicyV1,
	t: Pick<
		SessionWorkspaceReclamationTargetV1,
		"agentId" | "sessionId" | "sandboxId"
	>,
) {
	return (
		[
			"agent_api_031fb",
			"agent_ade388",
			"agent_api_ade388",
			"agent_a50d49bb",
			"agent_api_a50d49bb",
			"agent_api_fea4",
			"agent_api_bbbe",
		].some((id) => t.agentId.startsWith(id)) ||
		["cba6a0dd", "a8dd585a", "6e5488d7", "0e14bd4b"].some((id) =>
			t.sandboxId.startsWith(id),
		) ||
		p.retainedAgentIds.includes(t.agentId) ||
		p.retainedSessionIds.includes(t.sessionId) ||
		p.retainedSandboxIds.includes(t.sandboxId)
	);
}
export interface SessionWorkspaceReclamationStoreV1 {
	candidates(): Promise<
		readonly Omit<
			SessionWorkspaceReclamationTargetV1,
			"uid" | "resourceVersion"
		>[]
	>;
	prepare(
		target: SessionWorkspaceReclamationTargetV1,
	): Promise<"prepared" | "completed">;
	complete(target: SessionWorkspaceReclamationTargetV1): Promise<void>;
}
export interface SessionWorkspacePvcPortV1 {
	read(name: string): Promise<{ uid: string; resourceVersion: string } | null>;
	delete(target: SessionWorkspaceReclamationTargetV1): Promise<void>;
}
export function createSessionWorkspaceReclamationV1(
	store: SessionWorkspaceReclamationStoreV1,
	pvc: SessionWorkspacePvcPortV1,
) {
	return {
		async dryRun() {
			const result: SessionWorkspaceReclamationTargetV1[] = [];
			for (const candidate of await store.candidates()) {
				const identity = await pvc.read(candidate.name);
				if (identity) result.push({ ...candidate, ...identity });
			}
			return result;
		},
		async execute(target: SessionWorkspaceReclamationTargetV1) {
			const before = await pvc.read(target.name);
			if (
				before &&
				(before.uid !== target.uid ||
					before.resourceVersion !== target.resourceVersion)
			)
				throw new Error("WORKSPACE_PVC_IDENTITY_CONFLICT");
			const prepared = await store.prepare(target);
			if (prepared === "completed") {
				if (before) throw new Error("WORKSPACE_PVC_REAPPEARED");
				return "completed" as const;
			}
			if (before) await pvc.delete(target);
			if (await pvc.read(target.name))
				throw new Error("WORKSPACE_PVC_DELETION_UNCONFIRMED");
			await store.complete(target);
			return "completed" as const;
		},
	};
}
