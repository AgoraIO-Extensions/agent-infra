import assert from "node:assert/strict";
import test from "node:test";
import { createCleanupPlan } from "../deploy/ack/cleanup-plan.ts";

const uid = (n) =>
	`${n.toString().padStart(8, "0")}-1111-4111-8111-111111111111`;
function fixture(foreign = false) {
	const store = new Map();
	store.set("namespace/kube-system", { metadata: { uid: uid(1) } });
	store.set("namespace/agent-infra", { metadata: { uid: uid(2) } });
	for (const kind of [
		"deploy",
		"statefulset",
		"pod",
		"job",
		"service",
		"configmap",
		"secret",
		"pvc",
		"ingress",
		"serviceaccount",
		"role",
		"rolebinding",
		"networkpolicy",
		"resourcequota",
	])
		store.set(kind, {
			items: [
				{
					metadata: {
						name: `${kind}-1`,
						uid: uid(kind.length),
						labels: foreign
							? {}
							: { "agent-infra.agora.io/bootstrap-id": uid(3) },
					},
					status: { conditions: [{ type: "Ready", status: "True" }] },
				},
			],
		});
	store.set("mutatingadmissionpolicy/agent-infra-session-eci", {
		metadata: {
			name: "agent-infra-session-eci",
			uid: uid(4),
			labels: { "agent-infra.agora.io/bootstrap-id": uid(3) },
		},
	});
	store.set("mutatingadmissionpolicybinding/agent-infra-session-eci", {
		metadata: {
			name: "agent-infra-session-eci",
			uid: uid(5),
			labels: { "agent-infra.agora.io/bootstrap-id": uid(3) },
		},
	});
	const read = (args) => {
		if (args.includes("namespace"))
			return JSON.stringify(
				store.get(`namespace/${args[args.indexOf("namespace") + 1]}`),
			);
		if (
			args.includes("mutatingadmissionpolicy") ||
			args.includes("mutatingadmissionpolicybinding")
		)
			return store.get(`${args[0]}/${args[2]}`)
				? JSON.stringify(store.get(`${args[0]}/${args[2]}`))
				: "";
		const getIndex = args.indexOf("get");
		if (getIndex >= 0)
			return JSON.stringify(store.get(args[getIndex + 1]) ?? { items: [] });
		throw new Error("unexpected read");
	};
	return read;
}
test("cleanup plan only becomes ready when every resource and admission object is owned", () => {
	const input = {
		namespace: "agent-infra",
		clusterUid: uid(1),
		namespaceUid: uid(2),
		installationId: uid(3),
		release: "agent-infra-ack",
	};
	const ready = createCleanupPlan(input, fixture());
	assert.equal(ready.deletionReady, true);
	assert.equal(ready.foreignCount, 0);
	assert.equal(ready.dataRestoreVerified, false);
	assert.equal(JSON.stringify(ready).includes("deploy-1"), false);
	const foreign = createCleanupPlan(input, fixture(true));
	assert.equal(foreign.deletionReady, false);
	assert(foreign.foreignCount > 0);
});
test("cleanup plan rejects cluster/namespace UID drift", () => {
	const input = {
		namespace: "agent-infra",
		clusterUid: uid(1),
		namespaceUid: uid(2),
		installationId: uid(3),
		release: "agent-infra-ack",
	};
	assert.throws(() =>
		createCleanupPlan({ ...input, clusterUid: uid(9) }, fixture()),
	);
	assert.throws(() =>
		createCleanupPlan({ ...input, namespaceUid: uid(9) }, fixture()),
	);
});
