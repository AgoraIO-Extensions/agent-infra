/** Domain state; transport schemas are decoded by the Store/Worker adapters. */
export interface ExecutorInstanceResourceV2 {
	kind: "Pod" | "Service" | "Secret";
	namespace: string;
	name: string;
	uid: string;
	resourceVersion: string;
}
export interface ExecutorInstanceStateV2 {
	schemaVersion: 2;
	revision: number;
	sequence: number;
	attemptId: string;
	startupRef: string;
	sandboxId: string;
	namespace: string;
	podName: string;
	configurationRevision: number;
	configurationVersion: string;
	generation: number;
	resourceFence: number;
	bindingDigest: string;
	expiresAt: number;
	podUid: string | null;
	recordRef: string | null;
	phase:
		| "prepared"
		| "pod-pending"
		| "bound"
		| "delivery-pending"
		| "published"
		| "adopted"
		| "closing"
		| "retired";
	approval: { schemaVersion: 2; imageDigest: string; verificationRef: string };
	delivery: {
		hostPublicKey: string;
		runnerPublicKey: string;
		identityDigest: string;
		challenge: string;
	} | null;
	projection: ExecutorInstanceResourceV2 | null;
	cleanup: "open" | "delete-pending" | "absent";
	resources: ExecutorInstanceResourceV2[];
	adoption: { epoch: string; pinDigest: string; confirmedAt: number } | null;
	closureRef: string | null;
	retirement: {
		resource: ExecutorInstanceResourceV2;
		deleteAttemptId: string;
		state: "delete-requested" | "absent";
		callResult: "not-attempted" | "acknowledged" | "unknown" | "failed";
	}[];
}
export type ExecutorInstanceMutationV2 =
	| { kind: "read" }
	| {
			kind: "prepare";
			bindingDigest: string;
			configurationVersion: string;
			timeoutMs: number;
			approval: ExecutorInstanceStateV2["approval"];
	  }
	| {
			kind: "bind";
			attemptId: string;
			revision: number;
			podUid: string;
			resources: ExecutorInstanceResourceV2[];
	  }
	| {
			kind: "delivery";
			attemptId: string;
			revision: number;
			hostPublicKey: string;
			runnerPublicKey: string;
			identityDigest: string;
	  }
	| {
			kind: "published";
			attemptId: string;
			revision: number;
			projection: ExecutorInstanceResourceV2;
	  }
	| {
			kind: "adopted";
			attemptId: string;
			revision: number;
			proof: { epoch: string; pinDigest: string };
	  }
	| {
			kind:
				| "cleanup-request"
				| "cleanup-absent"
				| "seal"
				| "retired"
				| "pod-create";
			attemptId: string;
			revision: number;
	  }
	| {
			kind: "retirement-progress";
			attemptId: string;
			revision: number;
			progress: ExecutorInstanceStateV2["retirement"][number];
	  };
