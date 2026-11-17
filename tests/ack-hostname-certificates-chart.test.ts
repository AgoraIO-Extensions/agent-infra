import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { parseAllDocuments } from "yaml";

type Resource = {
	apiVersion?: string;
	kind?: string;
	metadata?: { name?: string };
	rules?: Array<{
		apiGroups?: string[];
		resources?: string[];
		verbs?: string[];
	}>;
};
const chart = "deploy/ack/chart";
function render(...args: string[]): Resource[] {
	return parseAllDocuments(
		execFileSync("helm", ["template", "hostname-test", chart, ...args], {
			encoding: "utf8",
		}),
	)
		.map((document) => document.toJSON() as Resource)
		.filter(Boolean);
}
function workerRole(resources: Resource[]) {
	const role = resources.find(
		(resource) =>
			resource.kind === "Role" &&
			resource.metadata?.name === "agent-infra-worker",
	);
	assert(role);
	return role;
}

test("hostname certificate permissions stay default-off", () => {
	assert.equal(
		workerRole(render()).rules?.some((rule) =>
			rule.apiGroups?.includes("cert-manager.io"),
		),
		false,
	);
});
test("opt-in grants only namespaced Certificate get/create and renders no certificate infrastructure", () => {
	const resources = render("--set", "worker.hostnameCertificates.enabled=true");
	assert.deepEqual(
		workerRole(resources).rules?.filter((rule) =>
			rule.apiGroups?.includes("cert-manager.io"),
		),
		[
			{
				apiGroups: ["cert-manager.io"],
				resources: ["certificates"],
				verbs: ["get", "create"],
			},
		],
	);
	assert.deepEqual(
		resources.filter((resource) =>
			["Certificate", "Issuer", "ClusterIssuer"].includes(resource.kind ?? ""),
		),
		[],
	);
});
test("hostname certificate permissions do not render during database bootstrap", () => {
	const resources = render(
		"--set",
		"worker.hostnameCertificates.enabled=true",
		"--set",
		"bootstrap.databaseOnly=true",
		"--set",
		"postgres.enabled=true",
	);
	assert.equal(
		resources.some(
			(resource) =>
				resource.kind === "Role" &&
				resource.metadata?.name === "agent-infra-worker",
		),
		false,
	);
});
test("hostname certificate permission values reject non-boolean and unknown keys", () => {
	for (const value of [
		"worker.hostnameCertificates.enabled=maybe",
		"worker.hostnameCertificates.delete=true",
	]) {
		const result = spawnSync(
			"helm",
			["template", "hostname-test", chart, "--set", value],
			{ encoding: "utf8" },
		);
		assert.notEqual(result.status, 0);
	}
});
