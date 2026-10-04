import { describe, expect, it } from "vitest";
import { createSessionSandboxBindingV1 } from "./session-sandbox.js";
import {
	canDrainSessionSandboxComputeV1,
	decideSessionSandboxDrainObservationV1,
	type SessionSandboxLifecycleV1,
	type SessionSandboxStopReceiptV1,
} from "./session-sandbox-lifecycle.js";
import type { SessionSandboxObservationV1 } from "./session-sandbox-reconciliation.js";

function fixture() {
	const sandbox = createSessionSandboxBindingV1(
		{
			schemaVersion: 1,
			actorId: "user",
			agentId: "agent",
			channelId: "web",
			authorizationRevision: "agent-1",
			supportsSupplementaryInstruction: false,
		},
		"session",
	);
	const resources = (
		[
			"Pod",
			"Service",
			"ServiceAccount",
			"PersistentVolumeClaim",
			"NetworkPolicy",
		] as const
	).map((kind) => ({
		kind,
		namespace: "sandbox-tests",
		name: sandbox.resourceName,
		uid: `uid-${kind}`,
		resourceVersion: "1",
	}));
	const lifecycle: SessionSandboxLifecycleV1 = {
		schemaVersion: 1,
		authority: {
			kind: "management",
			applicationId: "application",
			managementRevision: 2,
			managementFence: 2,
			workloadRevision: 2,
			targetDesiredState: "stopped",
		},
		source: {
			sandbox,
			resourceFence: 3,
			policy: {
				namespace: "sandbox-tests",
				resourceConfigurationHash: "policy",
				configurationRevision: 1,
				workloadRevision: 1,
				managementFence: 1,
				imageDigest: "sha256:source",
			},
			observation: { status: "ready", resources },
		},
		stopReceipt: null,
	};
	const retainedPVC = resources.find(
		(resource) => resource.kind === "PersistentVolumeClaim",
	)!;
	const receipt: SessionSandboxStopReceiptV1 = {
		schemaVersion: 1,
		sandboxId: sandbox.sandboxId,
		sessionId: sandbox.sessionId,
		sourceGeneration: 1,
		sourceResourceFence: 3,
		targetGeneration: 1,
		targetResourceFence: 4,
		removed: resources
			.filter((resource) => resource.kind !== "PersistentVolumeClaim")
			.map((resource) => ({
				resource: { ...resource, resourceVersion: "2" },
				preconditions: { uid: resource.uid, resourceVersion: "2" },
				absence: {
					kind: resource.kind,
					namespace: resource.namespace,
					name: resource.name,
				},
			})),
		retainedPVC,
	};
	const observation: SessionSandboxObservationV1 = {
		status: "stopped",
		resources: [retainedPVC],
		sourceStop: receipt,
	};
	return { sandbox, lifecycle, resourceFence: 4, observation };
}

describe("original source stop proof", () => {
	it("accepts latest per-object delete versions, actual absence of the Service route and the same PVC", () => {
		const input = fixture();
		expect(decideSessionSandboxDrainObservationV1(input)).toEqual({
			status: "stopped",
			observation: input.observation,
			finished: true,
			stopReceipt: input.observation.sourceStop,
		});
	});
	for (const field of [
		"sandboxId",
		"sessionId",
		"sourceGeneration",
		"sourceResourceFence",
		"targetGeneration",
		"targetResourceFence",
	] as const) {
		it(`retains source identities for a mismatched ${field}`, () => {
			const input = fixture();
			const receipt = input.observation.sourceStop!;
			const value = receipt[field];
			const observation = {
				...input.observation,
				sourceStop: {
					...receipt,
					[field]: typeof value === "number" ? value + 1 : `${value}-other`,
				},
			};
			expect(
				decideSessionSandboxDrainObservationV1({ ...input, observation }),
			).toMatchObject({
				status: "unknown",
				observation: input.lifecycle.source.observation,
				finished: false,
				stopReceipt: null,
			});
		});
	}
	it.each([
		"uid",
		"version",
		"absence-name",
		"absence-namespace",
		"missing-route",
		"missing-kind",
		"duplicate-kind",
		"pvc-swap",
		"missing-proof",
	])("rejects %s without forgetting the old source", (tamper) => {
		const input = fixture();
		const receipt = structuredClone(input.observation.sourceStop!);
		const first = receipt.removed[0]!;
		const removed = [...receipt.removed];
		let proof: SessionSandboxStopReceiptV1 | undefined = receipt;
		switch (tamper) {
			case "uid":
				removed[0] = {
					...first,
					preconditions: { ...first.preconditions, uid: "foreign" },
				};
				break;
			case "version":
				removed[0] = {
					...first,
					preconditions: { ...first.preconditions, resourceVersion: "old" },
				};
				break;
			case "absence-name":
				removed[0] = {
					...first,
					absence: { ...first.absence, name: "another-pod" },
				};
				break;
			case "absence-namespace":
				removed[0] = {
					...first,
					absence: { ...first.absence, namespace: "another-namespace" },
				};
				break;
			case "missing-route":
				removed.splice(
					removed.findIndex((item) => item.resource.kind === "Service"),
					1,
				);
				break;
			case "missing-kind":
				removed.pop();
				break;
			case "duplicate-kind":
				removed[1] = first;
				break;
			case "pvc-swap":
				proof = {
					...receipt,
					retainedPVC: { ...receipt.retainedPVC, uid: "new-volume" },
				};
				break;
			case "missing-proof":
				proof = undefined;
				break;
		}
		const observation = {
			...input.observation,
			sourceStop: proof && { ...proof, removed },
		};
		expect(
			decideSessionSandboxDrainObservationV1({ ...input, observation }),
		).toMatchObject({
			status: "unknown",
			observation: input.lifecycle.source.observation,
			finished: false,
		});
	});
	it("does not treat partial creation or an unproved optional controller as absence", () => {
		const input = fixture();
		const original = input.lifecycle.source.observation!;
		for (const resources of [
			original.resources.slice(1),
			[
				...original.resources,
				{
					...original.resources[0]!,
					kind: "StatefulSet" as const,
					uid: "controller",
				},
			],
		]) {
			const lifecycle = {
				...input.lifecycle,
				source: {
					...input.lifecycle.source,
					observation: { ...original, resources },
				},
			};
			expect(
				decideSessionSandboxDrainObservationV1({ ...input, lifecycle }),
			).toMatchObject({ status: "unknown", finished: false });
		}
	});
});

describe("original Execution drain eligibility", () => {
	it.each(["submitted", "waiting", "processing", "unknown", "invalid"])(
		"does not release %s occupancy",
		(status) => {
			expect(canDrainSessionSandboxComputeV1(["completed", status])).toBe(
				false,
			);
		},
	);
	it("permits compute cleanup only after all original executions are terminal", () => {
		expect(canDrainSessionSandboxComputeV1([])).toBe(true);
		expect(
			canDrainSessionSandboxComputeV1(["completed", "failed", "cancelled"]),
		).toBe(true);
	});
});
