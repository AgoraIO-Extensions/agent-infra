import assert from "node:assert/strict";
import { test } from "node:test";
import { connectionNetworkPolicy } from "../deploy/connection-network-policy.mjs";

const input = {
	namespace: "connection-test",
	dependencies: [
		{ kind: "dns", address: "192.0.2.53", protocol: "UDP", port: 53 },
		{ kind: "dns", address: "192.0.2.53", protocol: "TCP", port: 53 },
		{ kind: "ldap", address: "192.0.2.10", protocol: "TCP", port: 636 },
		{ kind: "postgres", address: "192.0.2.11", protocol: "TCP", port: 5432 },
		{ kind: "provider", address: "2001:db8::1", protocol: "TCP", port: 443 },
	],
};
test("policy selects only Connection API and denies everything except exact approved endpoints", () => {
	const policy = connectionNetworkPolicy(input);
	assert.deepEqual(policy.spec.podSelector.matchLabels, {
		"app.kubernetes.io/name": "connection-api",
	});
	assert.deepEqual(policy.spec.policyTypes, ["Egress"]);
	assert.equal(policy.spec.egress.length, 5);
	assert.equal(policy.spec.egress[4].to[0].ipBlock.cidr, "2001:db8::1/128");
});
test("rejects broad CIDRs, hostnames, missing dependencies and invalid ports/protocols", () => {
	for (const address of [
		"0.0.0.0/0",
		"::/0",
		"provider.example",
		"10.0.0.0/8",
		"",
	]) {
		assert.throws(() =>
			connectionNetworkPolicy({
				...input,
				dependencies: [
					...input.dependencies,
					{ kind: "provider", address, protocol: "TCP", port: 443 },
				],
			}),
		);
	}
	assert.throws(() =>
		connectionNetworkPolicy({
			...input,
			dependencies: input.dependencies.slice(1),
		}),
	);
	assert.throws(() =>
		connectionNetworkPolicy({
			...input,
			dependencies: input.dependencies.slice(0, 4),
		}),
	);
	assert.throws(() =>
		connectionNetworkPolicy({
			...input,
			dependencies: [
				...input.dependencies,
				{ kind: "provider", address: "192.0.2.1", protocol: "UDP", port: 443 },
			],
		}),
	);
});
