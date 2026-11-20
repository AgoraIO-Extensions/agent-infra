import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	type ExecutorInstanceMutationV2,
	type ExecutorInstanceStateV2,
	ExecutorInstanceStateV2Schema,
} from "@agent-infra/contracts/runtime";

/** Pure transitions; the Store supplies current lease/identity, clock and verified proof. */
export function transitionExecutorInstanceV2(input: {
	state: ExecutorInstanceStateV2 | null;
	mutation: ExecutorInstanceMutationV2;
	authority: {
		namespace: string;
		podName: string;
		sandboxId: string;
		generation: number;
		resourceFence: number;
		configurationRevision: number;
		imageDigest: string;
		now: number;
		hasUnresolvedExecution: boolean;
		proofVerified: boolean;
	};
}) {
	const { mutation, authority: a } = input;
	let state = input.state
		? ExecutorInstanceStateV2Schema.parse(input.state)
		: null;
	if (
		state &&
		(state.namespace !== a.namespace ||
			state.sandboxId !== a.sandboxId ||
			state.podName !== a.podName ||
			state.generation !== a.generation ||
			state.resourceFence !== a.resourceFence)
	)
		return null;
	if (mutation.kind === "read")
		return state ? { state, permit: false, clearReady: false } : null;
	if (mutation.kind === "prepare") {
		if (
			!/^[a-f0-9]{64}$/.test(mutation.bindingDigest) ||
			!Number.isSafeInteger(mutation.timeoutMs) ||
			mutation.timeoutMs < 1000 ||
			mutation.timeoutMs > 900000 ||
			mutation.approval.schemaVersion !== 2 ||
			!mutation.approval.imageDigest.endsWith(`@${a.imageDigest}`) ||
			!mutation.approval.verificationRef
		)
			return null;
		if (state && state.phase !== "retired")
			return state.bindingDigest === mutation.bindingDigest &&
				state.configurationVersion === mutation.configurationVersion &&
				state.configurationRevision === a.configurationRevision
				? { state, permit: false, clearReady: false }
				: null;
		if (
			state &&
			(!state.closureRef ||
				state.cleanup !== "absent" ||
				a.hasUnresolvedExecution)
		)
			return null;
		if (!state && a.hasUnresolvedExecution) return null;
		const attemptId = randomUUID();
		state = ExecutorInstanceStateV2Schema.parse({
			schemaVersion: 2,
			revision: 1,
			sequence: (state?.sequence ?? 0) + 1,
			attemptId,
			startupRef: `executor-v2-${createHash("sha256")
				.update(
					JSON.stringify([
						a.namespace,
						a.sandboxId,
						a.generation,
						a.resourceFence,
						attemptId,
					]),
				)
				.digest("hex")
				.slice(0, 40)}`,
			sandboxId: a.sandboxId,
			namespace: a.namespace,
			podName: a.podName,
			configurationRevision: a.configurationRevision,
			configurationVersion: mutation.configurationVersion,
			generation: a.generation,
			resourceFence: a.resourceFence,
			bindingDigest: mutation.bindingDigest,
			expiresAt: a.now + mutation.timeoutMs,
			podUid: null,
			recordRef: null,
			phase: "prepared",
			approval: mutation.approval,
			delivery: null,
			projection: null,
			cleanup: "open",
			resources: [],
			adoption: null,
			closureRef: null,
			retirement: [],
		});
		return { state, permit: false, clearReady: false };
	}
	if (
		!state ||
		state.attemptId !== mutation.attemptId ||
		state.configurationRevision !== a.configurationRevision
	)
		return null;
	if (mutation.revision !== state.revision)
		return { state, permit: false, clearReady: false };
	const next = structuredClone(state);
	let permit = false;
	let clearReady = false;
	switch (mutation.kind) {
		case "pod-create":
			if (state.phase !== "prepared" || a.now >= state.expiresAt) return null;
			next.phase = "pod-pending";
			permit = true;
			break;
		case "bind":
			if (state.podUid)
				return state.podUid === mutation.podUid &&
					isDeepStrictEqual(state.resources, mutation.resources)
					? { state, permit: false, clearReady: false }
					: null;
			if (
				state.phase !== "pod-pending" ||
				mutation.resources.length !== 2 ||
				new Set(mutation.resources.map((r) => r.kind)).size !== 2 ||
				mutation.resources.some(
					(r) =>
						!["Pod", "Service"].includes(r.kind) ||
						r.name !== a.podName ||
						r.namespace !== a.namespace ||
						!r.uid ||
						!r.resourceVersion,
				) ||
				!mutation.resources.some(
					(r) => r.kind === "Pod" && r.uid === mutation.podUid,
				)
			)
				return null;
			next.podUid = mutation.podUid;
			next.recordRef = randomUUID();
			next.resources = mutation.resources;
			next.phase = "bound";
			break;
		case "delivery":
			if (
				state.phase !== "bound" ||
				a.now >= state.expiresAt ||
				mutation.hostPublicKey === mutation.runnerPublicKey
			)
				return null;
			next.delivery = {
				hostPublicKey: mutation.hostPublicKey,
				runnerPublicKey: mutation.runnerPublicKey,
				identityDigest: mutation.identityDigest,
				challenge: randomUUID(),
			};
			next.phase = "delivery-pending";
			permit = true;
			break;
		case "published":
			if (
				!state.delivery ||
				!["delivery-pending", "published", "closing"].includes(state.phase) ||
				mutation.projection.kind !== "Secret" ||
				mutation.projection.name !== state.startupRef ||
				mutation.projection.namespace !== a.namespace ||
				(state.projection &&
					!isDeepStrictEqual(state.projection, mutation.projection))
			)
				return null;
			next.projection = mutation.projection;
			if (state.phase !== "closing") next.phase = "published";
			break;
		case "adopted":
			if (
				!a.proofVerified ||
				state.phase !== "published" ||
				!state.delivery ||
				!state.projection ||
				a.now >= state.expiresAt
			)
				return null;
			next.adoption = {
				epoch: mutation.proof.epoch,
				pinDigest: mutation.proof.pinDigest,
				confirmedAt: a.now,
			};
			next.phase = "adopted";
			break;
		case "cleanup-request":
			if (!state.delivery) next.cleanup = "absent";
			else if (
				!state.projection ||
				(!state.adoption && state.phase !== "closing")
			)
				return null;
			else next.cleanup = "delete-pending";
			break;
		case "cleanup-absent":
			if (state.cleanup !== "delete-pending") return null;
			next.cleanup = "absent";
			break;
		case "seal":
			if (a.hasUnresolvedExecution || state.phase === "retired") return null;
			// A create with no actual UID is unresolved, not a never-created instance.
			if (state.phase === "pod-pending" && !state.podUid) return null;
			next.phase = "closing";
			next.closureRef ??= randomUUID();
			clearReady = true;
			break;
		case "retirement-progress": {
			const p = mutation.progress;
			if (
				state.phase !== "closing" ||
				!state.resources.some(
					(r) =>
						r.kind === p.resource.kind &&
						r.uid === p.resource.uid &&
						r.namespace === p.resource.namespace &&
						r.name === p.resource.name,
				)
			)
				return null;
			const prior = state.retirement.find(
				(r) => r.resource.kind === p.resource.kind,
			);
			if (
				prior &&
				(prior.deleteAttemptId !== p.deleteAttemptId ||
					prior.resource.uid !== p.resource.uid ||
					(prior.state === "absent" && !isDeepStrictEqual(prior, p)))
			)
				return null;
			if (
				p.state === "absent" &&
				(!prior || ["failed", "not-attempted"].includes(p.callResult))
			)
				return null;
			next.retirement = [
				...state.retirement.filter((r) => r.resource.kind !== p.resource.kind),
				p,
			];
			break;
		}
		case "retired":
			if (
				state.phase !== "closing" ||
				a.hasUnresolvedExecution ||
				state.cleanup !== "absent" ||
				state.resources.some(
					(r) =>
						!state.retirement.some(
							(p) =>
								p.resource.uid === r.uid &&
								p.resource.kind === r.kind &&
								p.state === "absent",
						),
				)
			)
				return null;
			next.phase = "retired";
			break;
	}
	if (isDeepStrictEqual(next, state))
		return { state, permit: false, clearReady: false };
	next.revision++;
	next.sequence++;
	return {
		state: ExecutorInstanceStateV2Schema.parse(next),
		permit,
		clearReady,
	};
}
