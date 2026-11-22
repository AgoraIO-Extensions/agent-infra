import { describe, expect, it } from "vitest";
import { sessionSandboxSourceHostV1 } from "./session-sandbox-lifecycle.js";
import {
	decideSessionSandboxObservationV1,
	isSessionSandboxHostSourceValidV1,
	type SessionSandboxHostSourceV1,
	type SessionSandboxObservationV1,
	sessionSandboxObservedPodUidV1,
} from "./session-sandbox-reconciliation.js";

const namespace = "agent-sandboxes";
const resourceName = "sandbox-0a0b0c0d";
const podUid = "11111111-2222-4333-8444-555555555555";
const claim = {
	sandbox: {
		schemaVersion: 1,
		sandboxId: "0a0b0c0d",
		sessionId: "conversation-1",
		agentId: "agent-1",
		principal: { kind: "user", id: "user-1" },
		channelId: "web",
		generation: 2,
		resourceName,
		workspaceScope: "0a0b0c0d",
	},
	policy: { namespace },
	desiredState: "running",
} as never;

function observation(
	uid = podUid,
	extra: Partial<SessionSandboxObservationV1> = {},
): SessionSandboxObservationV1 {
	const resource = (kind: string, name = resourceName) => ({
		kind,
		namespace,
		name,
		uid: kind === "Pod" ? uid : `${kind}-uid`,
		resourceVersion: "1",
		...(kind === "Pod" ? { controllerUid: "StatefulSet-uid" } : {}),
	});
	return {
		status: "ready",
		resources: [
			resource("StatefulSet"),
			resource("Pod", `${resourceName}-0`),
			resource("Service"),
			resource("ServiceAccount"),
			resource("PersistentVolumeClaim"),
			resource("NetworkPolicy"),
			resource("Secret"),
		],
		...extra,
	} as SessionSandboxObservationV1;
}

const hostSource = (
	change: Partial<SessionSandboxHostSourceV1> = {},
): SessionSandboxHostSourceV1 => ({
	schemaVersion: 1,
	podUid,
	instanceRef: "hi1-instance",
	startRef: "hs1-start",
	hostSessionRef: "8f1b2c3d-host-session",
	sessionGeneration: 2,
	...change,
});

describe("Session Sandbox Host source (Spec §18.5.1, #4358 I3b1)", () => {
	it("belongs to the observed Pod UID, Session generation and executor epoch only", () => {
		const ready = observation();
		expect(sessionSandboxObservedPodUidV1(ready)).toBe(podUid);
		expect(
			isSessionSandboxHostSourceValidV1(
				{ ...ready, hostSource: hostSource() },
				2,
			),
		).toBe(true);
		for (const invalid of [
			// A Pod of the same name with another UID.
			hostSource({ podUid: "99999999-2222-4333-8444-555555555555" }),
			hostSource({ sessionGeneration: 1 }),
			hostSource({ instanceRef: "" }),
			hostSource({ startRef: "has space" }),
			hostSource({ epoch: "epoch-1" }),
			{ ...hostSource(), extra: "sk-canary" } as never,
		])
			expect(
				isSessionSandboxHostSourceValidV1({ ...ready, hostSource: invalid }, 2),
			).toBe(false);
		const executor = observation(podUid, {
			executorDrainRequired: true,
			executorInstance: {
				attemptId: "attempt-1",
				startupRef: "startup-1",
				podUid,
				epoch: "epoch-1",
			},
		});
		expect(
			isSessionSandboxHostSourceValidV1(
				{ ...executor, hostSource: hostSource({ epoch: "epoch-1" }) },
				2,
			),
		).toBe(true);
		for (const epoch of [undefined, "epoch-2"])
			expect(
				isSessionSandboxHostSourceValidV1(
					{
						...executor,
						hostSource: hostSource(epoch === undefined ? {} : { epoch }),
					},
					2,
				),
			).toBe(false);
	});

	it("keeps the Host source across a re-observation of the same Pod and drops it for a new Pod UID", () => {
		const previous = observation(podUid, { hostSource: hostSource() });
		expect(
			decideSessionSandboxObservationV1(claim, previous, observation())
				.observation.hostSource,
		).toEqual(hostSource());
		// The same Pod name with a new UID is a new Pod: it must be confirmed again.
		const replaced = decideSessionSandboxObservationV1(
			claim,
			null,
			observation("99999999-2222-4333-8444-555555555555"),
		);
		expect(replaced.observation.hostSource).toBeUndefined();
		// Without a stop receipt an unproved replacement keeps the previous observation as a
		// whole; its Host source never moves onto the new Pod UID.
		const carriedToNewPod = decideSessionSandboxObservationV1(
			claim,
			previous,
			observation("99999999-2222-4333-8444-555555555555"),
		);
		expect(carriedToNewPod.status).toBe("unknown");
		expect(carriedToNewPod.observation.hostSource?.podUid).toBe(
			sessionSandboxObservedPodUidV1(carriedToNewPod.observation),
		);
		// An observation carrying a Host source of another Pod is refused outright.
		expect(() =>
			decideSessionSandboxObservationV1(
				claim,
				null,
				observation(podUid, {
					hostSource: hostSource({
						podUid: "99999999-2222-4333-8444-555555555555",
					}),
				}),
			),
		).toThrow();
	});

	it("reads the original Host source only from a version 2 snapshot", () => {
		const policy = {
			namespace,
			configurationRevision: 7,
			imageDigest: `sha256:${"a".repeat(64)}`,
		};
		const snapshot = {
			schemaVersion: 2,
			sandbox: (claim as { sandbox: unknown }).sandbox,
			resourceFence: 4,
			policy,
			observation: observation(podUid, { hostSource: hostSource() }),
		};
		expect(sessionSandboxSourceHostV1(snapshot)).toEqual({
			sandboxRef: "0a0b0c0d",
			resourceFence: 4,
			sessionGeneration: 2,
			podUid,
			instanceRef: "hi1-instance",
			startRef: "hs1-start",
			hostSessionRef: "8f1b2c3d-host-session",
			configurationRevision: 7,
			imageDigest: `sha256:${"a".repeat(64)}`,
		});
		const { schemaVersion: _version, ...unversioned } = snapshot;
		for (const blocked of [
			// An unversioned (1) snapshot is history only, even if it carries the fields.
			unversioned,
			{ ...snapshot, observation: observation() },
			{
				...snapshot,
				policy: { ...policy, imageDigest: "registry/tag:latest" },
			},
			{ ...snapshot, policy: { namespace } },
			{
				...snapshot,
				observation: observation("99999999-2222-4333-8444-555555555555", {
					hostSource: hostSource(),
				}),
			},
			null,
		])
			expect(sessionSandboxSourceHostV1(blocked)).toBeUndefined();
	});
});
