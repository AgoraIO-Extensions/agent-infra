import { z } from "zod";

const id = z.string().min(1).max(256);
const positive = z.number().int().positive().safe();
export const ExecutorInstanceStartV2Schema = z.strictObject({
	schemaVersion: z.literal(2),
	purpose: z.literal("executor-instance-startup-v2"),
	podUid: id,
	bindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
	startupRef: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
	expiresAt: positive,
	instance: z.strictObject({
		attemptId: z.string().uuid(),
		recordRef: z.string().uuid(),
		sandboxId: id,
		configurationRevision: positive,
		configurationVersion: id,
		generation: positive,
		resourceFence: positive,
	}),
});
export type ExecutorInstanceStartV2 = z.infer<
	typeof ExecutorInstanceStartV2Schema
>;
/** Ordered, non-secret Store fact; shared by producer, Host and authoritative readback. */
export function executorInstanceFactBytesV2(input: ExecutorInstanceStartV2) {
	const value = ExecutorInstanceStartV2Schema.strip().parse(input);
	return JSON.stringify([
		value.schemaVersion,
		value.purpose,
		value.podUid,
		value.bindingDigest,
		value.startupRef,
		value.expiresAt,
		value.instance.attemptId,
		value.instance.recordRef,
		value.instance.sandboxId,
		value.instance.configurationRevision,
		value.instance.configurationVersion,
		value.instance.generation,
		value.instance.resourceFence,
	]);
}
export const ExecutorInstanceAdoptionV2Schema = z.strictObject({
	schemaVersion: z.literal(2),
	purpose: z.literal("executor-instance-adoption-v2"),
	challenge: z.string().uuid(),
	startupRef: id,
	attemptId: z.string().uuid(),
	recordRef: z.string().uuid(),
	podUid: id,
	bindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
	factDigest: z.string().regex(/^[a-f0-9]{64}$/),
	generation: positive,
	resourceFence: positive,
	epoch: z.string().uuid(),
	pinDigest: z.string().regex(/^[a-f0-9]{64}$/),
	signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export type ExecutorInstanceAdoptionV2 = z.infer<
	typeof ExecutorInstanceAdoptionV2Schema
>;
export function executorInstanceAdoptionBytesV2(
	input: Omit<ExecutorInstanceAdoptionV2, "signature">,
) {
	return JSON.stringify([
		2,
		"executor-instance-adoption-v2",
		input.challenge,
		input.startupRef,
		input.attemptId,
		input.recordRef,
		input.podUid,
		input.bindingDigest,
		input.factDigest,
		input.generation,
		input.resourceFence,
		input.epoch,
		input.pinDigest,
	]);
}

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const publicKey = z
	.string()
	.min(1)
	.max(1024)
	.regex(/^[A-Za-z0-9_-]+$/);
const resource = z.strictObject({
	kind: z.enum(["Pod", "Service", "Secret"]),
	namespace: id,
	name: id,
	uid: id,
	resourceVersion: id,
});
export const ExecutorInstanceStateV2Schema = z.strictObject({
	schemaVersion: z.literal(2),
	revision: positive,
	sequence: positive,
	attemptId: z.string().uuid(),
	startupRef: ExecutorInstanceStartV2Schema.shape.startupRef,
	sandboxId: id,
	namespace: id,
	podName: id,
	configurationRevision: positive,
	configurationVersion: id,
	generation: positive,
	resourceFence: positive,
	bindingDigest: digest,
	expiresAt: positive,
	podUid: id.nullable(),
	recordRef: z.string().uuid().nullable(),
	phase: z.enum([
		"prepared",
		"pod-pending",
		"bound",
		"delivery-pending",
		"published",
		"adopted",
		"closing",
		"retired",
	]),
	approval: z.strictObject({
		schemaVersion: z.literal(2),
		imageDigest: id,
		verificationRef: id,
	}),
	delivery: z
		.strictObject({
			hostPublicKey: publicKey,
			runnerPublicKey: publicKey,
			identityDigest: digest,
			challenge: z.string().uuid(),
		})
		.nullable(),
	projection: resource.nullable(),
	cleanup: z.enum(["open", "delete-pending", "absent"]),
	resources: z.array(resource).max(2),
	adoption: z
		.strictObject({
			epoch: z.string().uuid(),
			pinDigest: digest,
			confirmedAt: positive,
		})
		.nullable(),
	closureRef: z.string().uuid().nullable(),
	retirement: z
		.array(
			z.strictObject({
				resource,
				deleteAttemptId: z.string().uuid(),
				state: z.enum(["delete-requested", "absent"]),
				callResult: z.enum([
					"not-attempted",
					"acknowledged",
					"unknown",
					"failed",
				]),
			}),
		)
		.max(2),
});
export type ExecutorInstanceStateV2 = z.infer<
	typeof ExecutorInstanceStateV2Schema
>;
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
			resources: ExecutorInstanceStateV2["resources"];
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
			projection: NonNullable<ExecutorInstanceStateV2["projection"]>;
	  }
	| {
			kind: "adopted";
			attemptId: string;
			revision: number;
			proof: ExecutorInstanceAdoptionV2;
	  }
	| {
			kind: "cleanup-request" | "cleanup-absent" | "seal" | "retired";
			attemptId: string;
			revision: number;
	  }
	| { kind: "pod-create"; attemptId: string; revision: number }
	| {
			kind: "retirement-progress";
			attemptId: string;
			revision: number;
			progress: ExecutorInstanceStateV2["retirement"][number];
	  };
export function executorInstanceStartV2(
	state: ExecutorInstanceStateV2,
): ExecutorInstanceStartV2 {
	return ExecutorInstanceStartV2Schema.parse({
		schemaVersion: 2,
		purpose: "executor-instance-startup-v2",
		podUid: state.podUid,
		bindingDigest: state.bindingDigest,
		startupRef: state.startupRef,
		expiresAt: state.expiresAt,
		instance: {
			attemptId: state.attemptId,
			recordRef: state.recordRef,
			sandboxId: state.sandboxId,
			configurationRevision: state.configurationRevision,
			configurationVersion: state.configurationVersion,
			generation: state.generation,
			resourceFence: state.resourceFence,
		},
	});
}

export const ExecutorInstanceAdoptionReadV2Schema = z.strictObject({
	schemaVersion: z.literal(2),
	challenge: z.string().uuid(),
	startupRef: id,
	attemptId: z.string().uuid(),
	podUid: id,
});
export type ExecutorInstanceAdoptionReadV2 = z.infer<
	typeof ExecutorInstanceAdoptionReadV2Schema
>;
