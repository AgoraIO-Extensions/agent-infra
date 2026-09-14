import assert from "node:assert/strict";
import test from "node:test";
import { bitbucketServerConnectionCatalog } from "./bitbucket-server.ts";
import { confluenceServerConnectionCatalog } from "./confluence-server.ts";
import { githubConnectionCatalog } from "./index.ts";
import { jiraServerConnectionCatalog } from "./jira-server.ts";
import {
	assertTestProjectMutation,
	capabilityCoverage,
	capabilityVerificationMatrix,
	runTestProjectMutation,
	runTestProjectRead,
	testResourceMarker,
} from "./test-project.ts";
import { githubV7VerificationEvidence } from "./verification/github-v7.ts";

const catalogs = [
	githubConnectionCatalog,
	bitbucketServerConnectionCatalog,
	jiraServerConnectionCatalog,
	confluenceServerConnectionCatalog,
] as const;

test("every catalog action receives a fail-closed conformance strategy", () => {
	const coverage = capabilityCoverage(catalogs);
	assert.equal(
		coverage.length,
		catalogs.reduce((total, catalog) => total + catalog.actions.length, 0),
	);
	assert.equal(
		new Set(coverage.map((item) => item.actionId)).size,
		coverage.length,
	);
	assert.deepEqual(
		new Set(coverage.map((item) => item.provider)),
		new Set(["github", "bitbucket", "jira", "confluence"]),
	);
	for (const item of coverage) {
		assert.equal(
			item.strategy,
			item.effect === "READ" ? "read-smoke" : "isolated-mutation",
		);
	}
});

test("GitHub verification matrix binds exact live evidence to 9 of 145 actions", () => {
	const matrix = capabilityVerificationMatrix(
		githubConnectionCatalog,
		githubV7VerificationEvidence,
	);
	assert.equal(matrix.length, 145);
	assert.equal(
		matrix.filter((item) => item.status === "LIVE_VERIFIED").length,
		9,
	);
	assert.equal(
		matrix.filter((item) => item.status === "UNVERIFIED").length,
		136,
	);
	assert.ok(
		matrix
			.filter((item) => item.status === "LIVE_VERIFIED")
			.every(
				(item) =>
					item.actionVersionId.endsWith("@v7") &&
					item.evidence?.cleanup === "SUCCEEDED" &&
					item.evidence.runId === "34821150745-1",
			),
	);

	const bumpedCatalog = {
		...githubConnectionCatalog,
		actions: githubConnectionCatalog.actions.map((action) =>
			action.name === "github.get_repository"
				? { ...action, id: "github.get_repository@v8" }
				: action,
		),
	};
	assert.throws(
		() =>
			capabilityVerificationMatrix(bumpedCatalog, githubV7VerificationEvidence),
		/unknown ActionVersions/,
	);
});

test("capability coverage rejects duplicate IDs and unknown effects", () => {
	const action = {
		effect: "READ" as const,
		id: "provider.action@v1",
		name: "provider.action",
	};
	assert.throws(
		() =>
			capabilityCoverage([{ actions: [action, action], provider: "provider" }]),
		/duplicate/,
	);
	assert.throws(
		() =>
			capabilityCoverage([
				{
					actions: [{ ...action, effect: "UNKNOWN" }],
					provider: "provider",
				} as never,
			]),
		/unsupported effect/,
	);
});

test("mutation requires an enabled exact test project and run marker", () => {
	const project = {
		containerId: "project-42",
		enabled: true,
		provider: "jira",
		runId: "run-123",
		tenantId: "jira-test",
	};
	const target = {
		containerId: project.containerId,
		marker: testResourceMarker(project.runId),
		provider: project.provider,
		runId: project.runId,
		tenantId: project.tenantId,
	};

	assert.doesNotThrow(() =>
		assertTestProjectMutation({ operation: "CREATE", project, target }),
	);
	assert.throws(
		() =>
			assertTestProjectMutation({
				operation: "CREATE",
				project: { ...project, enabled: false },
				target,
			}),
		/disabled/,
	);
	assert.throws(
		() =>
			assertTestProjectMutation({
				operation: "CREATE",
				project: { ...project, enabled: "true" } as never,
				target,
			}),
		/disabled/,
	);
	assert.throws(
		() =>
			assertTestProjectMutation({
				operation: "CREATE",
				project: { ...project, tenantId: undefined } as never,
				target,
			}),
		/tenantId is required/,
	);
	for (const field of [
		"provider",
		"tenantId",
		"containerId",
		"runId",
	] as const) {
		assert.throws(
			() =>
				assertTestProjectMutation({
					operation: "CREATE",
					project,
					target: { ...target, [field]: "other" },
				}),
			new RegExp(field),
		);
	}
	assert.throws(
		() =>
			assertTestProjectMutation({
				operation: "CREATE",
				project,
				target: { ...target, marker: "connection-e2e:other" },
			}),
		/marker/,
	);
});

test("update and delete require the recorded resource from the same run", () => {
	const project = {
		containerId: "repo-42",
		enabled: true,
		provider: "github",
		runId: "run-456",
		tenantId: "test-org",
	};
	const target = {
		containerId: project.containerId,
		marker: testResourceMarker(project.runId),
		provider: project.provider,
		runId: project.runId,
		tenantId: project.tenantId,
	};
	const resource = { ...target, resourceId: "issue-7" };

	assert.doesNotThrow(() =>
		assertTestProjectMutation({
			operation: "UPDATE",
			project,
			resource,
			target,
		}),
	);
	assert.throws(
		() => assertTestProjectMutation({ operation: "DELETE", project, target }),
		/requires a recorded test resource/,
	);
	assert.throws(
		() =>
			assertTestProjectMutation({
				operation: "UPDATE",
				project,
				resource: { ...resource, runId: "older-run" },
				target,
			}),
		/recorded test resource runId/,
	);
	assert.throws(
		() =>
			assertTestProjectMutation({
				operation: "DELETE",
				project,
				resource: { ...resource, resourceId: "" },
				target,
			}),
		/resourceId/,
	);
});

test("guard failure prevents the real provider callback", async () => {
	let executions = 0;
	await assert.rejects(
		runTestProjectMutation({
			execute: async () => {
				executions += 1;
			},
			operation: "CREATE",
			project: {
				containerId: "CONNTEST",
				enabled: false,
				provider: "jira",
				runId: "run-789",
				tenantId: "jira-test",
			},
			target: {
				containerId: "CONNTEST",
				marker: "connection-e2e:run-789",
				provider: "jira",
				runId: "run-789",
				tenantId: "jira-test",
			},
		}),
		/request is disabled/,
	);
	assert.equal(executions, 0);
});

test("read smoke is disabled by default and confined to the test container", async () => {
	let executions = 0;
	const execute = async () => {
		executions += 1;
	};
	const project = {
		containerId: "CONNTEST",
		enabled: false,
		provider: "jira",
		runId: "run-read",
		tenantId: "jira-test",
	};
	const target = {
		containerId: project.containerId,
		provider: project.provider,
		tenantId: project.tenantId,
	};

	await assert.rejects(
		runTestProjectRead({ execute, project, target }),
		/disabled/,
	);
	await assert.rejects(
		runTestProjectRead({
			execute,
			project: { ...project, enabled: true },
			target: { ...target, containerId: "EXISTING" },
		}),
		/containerId/,
	);
	assert.equal(executions, 0);
});
