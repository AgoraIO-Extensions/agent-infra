import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { parseAllDocuments } from "yaml";

const namespace = "ack-worker-test";
const internalName = "agent-infra-worker-internal";

function render(...args) {
	return parseAllDocuments(
		execFileSync(
			"helm",
			[
				"template",
				"ack-worker-internal-test",
				"deploy/ack/chart",
				"--namespace",
				namespace,
				...args,
			],
			{ encoding: "utf8" },
		),
	)
		.map((document) => document.toJSON())
		.filter(Boolean);
}

function selects(selector, labels) {
	return Object.entries(selector).every(
		([key, value]) => labels[key] === value,
	);
}

test("ACK internal Worker Service reaches only the existing Worker listener", () => {
	const resources = render();
	const services = resources.filter(
		(resource) =>
			resource.kind === "Service" && resource.metadata.name === internalName,
	);
	assert.equal(
		services.length,
		1,
		"API Worker DNS requires one internal Service",
	);
	const service = services[0];
	assert.equal(service.spec.type, "ClusterIP");
	assert.equal(service.spec.externalIPs, undefined);
	assert.equal(service.spec.externalName, undefined);
	assert.deepEqual(service.spec.ports, [
		{ name: "http", protocol: "TCP", port: 3004, targetPort: 3004 },
	]);
	assert.deepEqual(service.spec.selector, {
		"app.kubernetes.io/name": "agent-infra",
		"app.kubernetes.io/component": "platform-worker",
	});
	const deployments = resources.filter(
		(resource) => resource.kind === "Deployment",
	);
	assert.deepEqual(
		deployments
			.filter((deployment) =>
				selects(
					service.spec.selector,
					deployment.spec.template.metadata.labels,
				),
			)
			.map((deployment) => deployment.metadata.name),
		["agent-infra-worker"],
	);
});

test("ACK Worker ingress admits only API and identified Session callbacks in its namespace", () => {
	const resources = render();
	const policies = resources.filter(
		(resource) =>
			resource.kind === "NetworkPolicy" &&
			resource.metadata.name === internalName,
	);
	assert.equal(policies.length, 1);
	const policy = policies[0];
	assert.deepEqual(policy.spec.podSelector, {
		matchLabels: {
			"app.kubernetes.io/name": "agent-infra",
			"app.kubernetes.io/component": "platform-worker",
		},
	});
	assert.deepEqual(policy.spec.policyTypes, ["Ingress"]);
	assert.equal(policy.spec.egress, undefined);
	assert.equal(policy.spec.ingress.length, 2);
	const [api, session] = policy.spec.ingress;
	for (const rule of [api, session]) {
		assert.deepEqual(rule.ports, [{ protocol: "TCP", port: 3004 }]);
		assert.equal(rule.from.length, 1);
		// A podSelector-only peer is confined to the policy's namespace.
		assert.deepEqual(Object.keys(rule.from[0]), ["podSelector"]);
	}
	assert.deepEqual(api.from[0].podSelector, {
		matchLabels: {
			"app.kubernetes.io/name": "agent-infra",
			"app.kubernetes.io/component": "platform-api",
		},
	});
	const identityLabels = [
		"agent-infra.agora.io/sandbox-id",
		"agent-infra.agora.io/agent-ref",
		"agent-infra.agora.io/session-ref",
		"agent-infra.agora.io/generation",
	];
	assert.deepEqual(session.from[0].podSelector, {
		matchLabels: { "agent-infra.agora.io/managed": "session-sandbox-v1" },
		matchExpressions: identityLabels.map((key) => ({
			key,
			operator: "Exists",
		})),
	});
	const admits = (labels, podNamespace = namespace) =>
		podNamespace === namespace &&
		policy.spec.ingress.some(({ from }) => {
			const selector = from[0].podSelector;
			return (
				selects(selector.matchLabels, labels) &&
				(selector.matchExpressions ?? []).every(({ key }) =>
					Object.hasOwn(labels, key),
				)
			);
		});
	const apiLabels = api.from[0].podSelector.matchLabels;
	const sessionLabels = {
		"agent-infra.agora.io/managed": "session-sandbox-v1",
		...Object.fromEntries(identityLabels.map((key) => [key, "fixture"])),
	};
	assert(admits(apiLabels));
	assert(admits(sessionLabels));
	assert(!admits(apiLabels, "another-namespace"));
	assert(!admits(sessionLabels, "another-namespace"));
	assert(!admits({}));
	for (const component of ["web", "platform-worker", "agent-runtime-host"])
		assert(!admits({ ...apiLabels, "app.kubernetes.io/component": component }));
	assert(
		!admits({ ...sessionLabels, "agent-infra.agora.io/managed": "agent" }),
	);
	for (const missing of identityLabels) {
		const incomplete = { ...sessionLabels };
		delete incomplete[missing];
		assert(!admits(incomplete), `Session callback requires ${missing}`);
	}
});

test("database-only bootstrap does not publish the Worker internal entry", () => {
	const resources = render(
		"--set",
		"bootstrap.databaseOnly=true,postgres.enabled=true,postgres.adminUser=bootstrap_admin,postgres.initialDatabase=postgres,postgres.adminSecret=db-admin,postgres.initializationSecret=db-init,postgres.bootstrapInstallationId=11111111-1111-4111-8111-111111111111",
	);
	assert(
		!resources.some(
			(resource) =>
				resource.metadata.name === internalName ||
				(resource.kind === "Deployment" &&
					resource.metadata.name === "agent-infra-worker"),
		),
	);
});
