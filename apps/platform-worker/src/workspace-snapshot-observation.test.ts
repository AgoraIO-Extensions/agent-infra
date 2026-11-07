import type { OperationalEvent } from "@agent-infra/observability";
import type { V1ContainerStatus, V1Pod } from "@kubernetes/client-node";
import { expect, it } from "vitest";
import {
	applyWorkspaceSnapshotProjectionV1,
	projectWorkspaceSnapshotMaterializerV1,
} from "./workspace-snapshot-materializer.js";
import {
	createWorkspaceSnapshotObserverV1,
	workspaceSnapshotPodObservationV1,
} from "./workspace-snapshot-observation.js";

const image = `registry.example.test/worker@sha256:${"a".repeat(64)}`;
const projection = projectWorkspaceSnapshotMaterializerV1(
	[
		{
			snapshotId: "snapshot-a",
			name: "repo",
			digest: `sha256:${"b".repeat(64)}`,
			sizeBytes: 100,
			objectRef: "object-a",
			signedUrl: "https://objects.example.test/private?signature=secret",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		},
	],
	{
		imageDigest: image,
		allowedOrigins: ["https://objects.example.test"],
		credentialSecretName: "snapshot-credentials",
		cacheSizeLimit: "2Gi",
		resources: {
			requests: { cpu: "100m", memory: "128Mi" },
			limits: { cpu: "1", memory: "512Mi" },
		},
	},
);

function pod(status: Partial<V1ContainerStatus> = {}): V1Pod {
	return {
		metadata: { uid: "pod-a" },
		spec: structuredClone(
			applyWorkspaceSnapshotProjectionV1(
				{ containers: [{ name: "agent" }] },
				projection,
			),
		),
		status: {
			initContainerStatuses: [
				{
					name: "workspace-snapshot-materializer",
					image,
					imageID: image,
					ready: true,
					restartCount: 0,
					state: {
						terminated: {
							exitCode: 0,
							startedAt: new Date("2026-11-07T01:00:00Z"),
							finishedAt: new Date("2026-11-07T01:00:02Z"),
							message: "private source and signature=secret",
						},
					},
					...status,
				},
			],
		},
	};
}

it("projects actual init duration and attempt without any raw message or URL", () => {
	expect(workspaceSnapshotPodObservationV1(pod(), projection)).toEqual({
		podUid: "pod-a",
		imageDigest: `sha256:${"a".repeat(64)}`,
		outcome: "completed",
		attempt: 1,
		durationMs: 2000,
	});
	expect(
		JSON.stringify(workspaceSnapshotPodObservationV1(pod(), projection)),
	).not.toMatch(/private|secret|signature|https/);
});

it("accepts Kubernetes status imageID when image is reported as a content digest", () => {
	const observed = workspaceSnapshotPodObservationV1(
		pod({
			image: `sha256:${"c".repeat(64)}`,
			imageID: image,
		}),
		projection,
	);
	expect(observed).toMatchObject({ outcome: "completed", attempt: 1 });
});

it("reports the same failed attempt while it is terminated or waiting for a restart", () => {
	const failed = {
		exitCode: 1,
		startedAt: new Date("2026-11-07T01:00:00Z"),
		finishedAt: new Date("2026-11-07T01:00:03Z"),
	};
	const terminated = workspaceSnapshotPodObservationV1(
		pod({ state: { terminated: failed } }),
		projection,
	);
	const waiting = workspaceSnapshotPodObservationV1(
		pod({
			restartCount: 1,
			state: { waiting: { reason: "CrashLoopBackOff", message: "secret" } },
			lastState: { terminated: failed },
		}),
		projection,
	);
	expect(terminated).toEqual(waiting);
	expect(waiting).toMatchObject({
		outcome: "failed",
		attempt: 1,
		durationMs: 3000,
	});
});

it("rejects unrelated statuses, drifted specs and invalid restart counters", () => {
	expect(
		workspaceSnapshotPodObservationV1(
			pod({ name: "untrusted-init" }),
			projection,
		),
	).toBeUndefined();
	expect(
		workspaceSnapshotPodObservationV1(
			pod({ image: "other-image" }),
			projection,
		),
	).toBeUndefined();
	expect(
		workspaceSnapshotPodObservationV1(pod({ restartCount: -1 }), projection),
	).toBeUndefined();
	const drifted = pod();
	if (!drifted.spec?.initContainers?.[0]) throw new Error();
	drifted.spec.initContainers[0].command = ["sh", "-c", "echo secret"];
	expect(
		workspaceSnapshotPodObservationV1(drifted, projection),
	).toBeUndefined();
	expect(
		workspaceSnapshotPodObservationV1(
			pod({ state: { running: {} } }),
			projection,
		),
	).toBeUndefined();
});

it("deduplicates repeated polling but records a later successful retry", () => {
	const events: OperationalEvent[] = [];
	const observe = createWorkspaceSnapshotObserverV1((event) => {
		events.push(event);
	});
	const failed = workspaceSnapshotPodObservationV1(
		pod({ state: { terminated: { exitCode: 1 } } }),
		projection,
	);
	const completed = workspaceSnapshotPodObservationV1(
		pod({ restartCount: 1 }),
		projection,
	);
	if (!failed || !completed) throw new Error();
	observe({ ...failed, agentId: "agent-a" });
	observe({ ...failed, agentId: "agent-a" });
	observe({ ...completed, agentId: "agent-a" });
	expect(events).toHaveLength(2);
	expect(events[0]).toMatchObject({
		operationRef: "workspace.snapshot.materialize",
		failureStep: "workspace.materialization",
		attempt: 1,
	});
	expect(events[1]).toMatchObject({
		outcome: "completed",
		attempt: 2,
		durationMs: 2000,
	});
});
