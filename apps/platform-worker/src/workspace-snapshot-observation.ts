import type { OperationalEvent } from "@agent-infra/observability";
import {
	isWorkspaceSnapshotObservationValidV1,
	type WorkspaceSnapshotObservationV1,
} from "@agent-infra/platform-core";
import type { V1Pod } from "@kubernetes/client-node";
import {
	type WorkspaceSnapshotPodProjectionV1,
	workspaceSnapshotPodSpecMatchesV1,
} from "./workspace-snapshot-materializer.js";

export type WorkspaceSnapshotObservationCallbackV1 = (
	observation: WorkspaceSnapshotObservationV1 & { readonly agentId: string },
) => void;

/** The caller verifies Pod ownership before consuming this bounded init-only status. */
export function workspaceSnapshotPodObservationV1(
	pod: V1Pod,
	projection: WorkspaceSnapshotPodProjectionV1 | undefined,
): WorkspaceSnapshotObservationV1 | undefined {
	if (
		!projection ||
		!pod.metadata?.uid ||
		!workspaceSnapshotPodSpecMatchesV1(pod.spec, projection)
	)
		return undefined;
	const expected = projection.initContainers.find(
		(init) => init.name === "workspace-snapshot-materializer",
	);
	const status = pod.status?.initContainerStatuses?.filter(
		(init) => init.name === expected?.name,
	);
	if (!expected?.image || status?.length !== 1 || !status[0]) return undefined;
	const init = status[0];
	const expectedDigest = expected.image.split("@")[1];
	const observedDigests = [init.image, init.imageID]
		.map((image) => image?.split("@")[1])
		.filter((digest): digest is string => typeof digest === "string");
	if (
		!expectedDigest ||
		!init.imageID ||
		init.imageID.split("@")[1] !== expectedDigest
	)
		return undefined;
	const imageMatches =
		init.image === expected.image ||
		(init.image?.startsWith("sha256:") === true &&
			!!expectedDigest &&
			observedDigests.includes(expectedDigest));
	if (
		!imageMatches ||
		!Number.isSafeInteger(init.restartCount) ||
		init.restartCount < 0
	)
		return undefined;
	const current = init.state?.terminated;
	const previous = init.lastState?.terminated;
	const terminated =
		current ?? (previous?.exitCode !== 0 ? previous : undefined);
	const waitingFailure = [
		"CrashLoopBackOff",
		"ErrImagePull",
		"ImagePullBackOff",
		"InvalidImageName",
		"CreateContainerConfigError",
		"CreateContainerError",
		"RunContainerError",
	].includes(init.state?.waiting?.reason ?? "");
	if (!terminated && !waitingFailure) return undefined;
	const startedAt =
		terminated?.startedAt && new Date(terminated.startedAt).getTime();
	const finishedAt =
		terminated?.finishedAt && new Date(terminated.finishedAt).getTime();
	const durationMs =
		typeof startedAt === "number" && typeof finishedAt === "number"
			? finishedAt - startedAt
			: undefined;
	const observation = {
		podUid: pod.metadata.uid,
		imageDigest: expected.image.split("@")[1] ?? "",
		outcome:
			terminated?.exitCode === 0 ? ("completed" as const) : ("failed" as const),
		attempt: current || !terminated ? init.restartCount + 1 : init.restartCount,
		...(durationMs !== undefined &&
		Number.isFinite(durationMs) &&
		durationMs >= 0 &&
		durationMs <= 3_600_000
			? { durationMs }
			: {}),
	};
	return isWorkspaceSnapshotObservationValidV1(observation)
		? observation
		: undefined;
}

/** Deduplicate repeated polling of one Pod attempt without keeping an unbounded UID set. */
export function createWorkspaceSnapshotObserverV1(
	record: (event: OperationalEvent) => void,
): WorkspaceSnapshotObservationCallbackV1 {
	const observed = new Set<string>();
	return (observation) => {
		const { agentId, ...snapshot } = observation;
		if (!isWorkspaceSnapshotObservationValidV1(snapshot)) return;
		const key = `${snapshot.podUid}:${snapshot.attempt}:${snapshot.outcome}`;
		if (observed.has(key)) return;
		observed.add(key);
		if (observed.size > 4096) {
			const oldest = observed.values().next().value;
			if (oldest) observed.delete(oldest);
		}
		try {
			record({
				stage: "workload",
				operationRef: "workspace.snapshot.materialize",
				agentId,
				sandboxResourceUid: snapshot.podUid,
				imageDigest: snapshot.imageDigest,
				outcome: snapshot.outcome,
				attempt: snapshot.attempt,
				...(snapshot.durationMs === undefined
					? {}
					: { durationMs: snapshot.durationMs }),
				...(snapshot.outcome === "failed"
					? {
							code: "WORKLOAD_UNAVAILABLE",
							failureStep: "workspace.materialization",
						}
					: {}),
			});
		} catch {
			// Observational collection cannot change readiness or retry decisions.
		}
	};
}
