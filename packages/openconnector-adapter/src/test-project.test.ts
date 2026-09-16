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
	type LiveVerificationEvidence,
	runTestProjectMutation,
	runTestProjectRead,
	testResourceMarker,
} from "./test-project.ts";
import {
	githubV7ReviewerVerificationEvidence,
	githubV7VerificationEvidence,
	githubV7VerificationEvidenceRecords,
} from "./verification/github-v7.ts";
import { githubV7LowRiskWriteScenarios } from "./verification/github-v7-low-risk-write-scenarios.ts";
import { githubV7ReadScenarios } from "./verification/github-v7-read-scenarios.ts";

const catalogs = [
	githubConnectionCatalog,
	bitbucketServerConnectionCatalog,
	jiraServerConnectionCatalog,
	confluenceServerConnectionCatalog,
] as const;

test("GitHub v7 low-risk writes have an exact isolated cleanup scenario", () => {
	const approved = [
		"create_ref",
		"update_ref",
		"rename_branch",
		"delete_ref",
		"create_label",
		"update_label",
		"delete_label",
		"add_issue_labels",
		"set_issue_labels",
		"remove_issue_label",
		"clear_issue_labels",
		"add_issue_assignees",
		"remove_issue_assignees",
		"lock_issue",
		"unlock_issue",
		"create_or_update_file",
		"delete_file",
		"replace_repository_topics",
		"star_repository",
		"unstar_repository",
		"create_milestone",
		"update_milestone",
		"delete_milestone",
		"generate_release_notes",
		"create_release",
		"update_release",
		"delete_release",
	]
		.map((name) => `github.${name}@v7`)
		.sort();
	const actionVersionIds = githubV7LowRiskWriteScenarios.map(
		(scenario) => scenario.actionVersionId,
	);
	assert.equal(actionVersionIds.length, 27);
	assert.equal(new Set(actionVersionIds).size, actionVersionIds.length);
	assert.deepEqual([...actionVersionIds].sort(), approved);
	for (const scenario of githubV7LowRiskWriteScenarios) {
		const action = githubConnectionCatalog.actions.find(
			(item) => item.id === scenario.actionVersionId,
		);
		assert.equal(action?.effect, "WRITE");
		assert.equal(scenario.target.externalAccount, "328682695");
		assert.equal(scenario.target.organizationId, "329053903");
		assert.equal(scenario.target.repositoryId, "1369705971");
		assert.match(scenario.marker, /^connection-e2e:<runId>/);
		assert.ok(["DELETE", "RESTORE"].includes(scenario.cleanup));
	}
});

test("GitHub v7 read scenarios exactly cover the catalog read actions", () => {
	const catalogReads = githubConnectionCatalog.actions
		.filter((action) => action.effect === "READ")
		.map((action) => action.id)
		.sort();
	const scenarioIds = githubV7ReadScenarios
		.map((scenario) => scenario.actionVersionId)
		.sort();

	assert.equal(catalogReads.length, 78);
	assert.equal(new Set(scenarioIds).size, githubV7ReadScenarios.length);
	assert.deepEqual(scenarioIds, catalogReads);
	for (const scenario of githubV7ReadScenarios) {
		assert.ok(
			["ACCOUNT", "ORGANIZATION", "REPOSITORY"].includes(scenario.boundary),
		);
		assert.ok(scenario.fixture.length > 0);
		assert.equal(scenario.target.externalAccount, "328682695");
		if (scenario.boundary === "REPOSITORY") {
			assert.equal(scenario.target.repositoryId, "1369705971");
		}
		if (scenario.boundary === "ORGANIZATION") {
			assert.equal(scenario.target.organizationId, "329053903");
		}
	}
	assert.deepEqual(
		githubV7ReadScenarios
			.filter((scenario) => scenario.execution !== "LIVE")
			.map((scenario) => scenario.actionVersionId),
		["github.get_pull_request_review@v7"],
	);
	for (const scenario of githubV7ReadScenarios.filter(
		(item) => item.execution === "LIVE",
	)) {
		const action = githubConnectionCatalog.actions.find(
			(item) => item.id === scenario.actionVersionId,
		);
		assert.ok(action);
		for (const field of action.inputSchema.required) {
			assert.ok(
				field in scenario.input,
				`${scenario.actionVersionId}: ${field}`,
			);
		}
		assert.ok(
			scenario.input.owner === undefined ||
				scenario.input.owner === "AgoraConnectionE2EORG",
		);
		assert.ok(
			scenario.input.repo === undefined ||
				scenario.input.repo === "connector-conformance",
		);
		assert.ok(
			scenario.input.org === undefined ||
				scenario.input.org === "AgoraConnectionE2EORG",
		);
		assert.ok(
			scenario.input.username === undefined ||
				scenario.input.username === "AGORAconnectionE2E",
		);
	}
});

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

test("GitHub verification matrix binds account-scoped evidence to 127 actions", () => {
	const matrix = capabilityVerificationMatrix(
		githubConnectionCatalog,
		githubV7VerificationEvidenceRecords,
	);
	assert.equal(matrix.length, 145);
	assert.equal(
		matrix.filter((item) => item.status === "LIVE_VERIFIED").length,
		127,
	);
	assert.equal(
		matrix.filter((item) => item.status === "UNVERIFIED").length,
		18,
	);
	assert.equal(
		matrix.filter(
			(item) => item.effect === "READ" && item.status === "LIVE_VERIFIED",
		).length,
		78,
	);
	const reviewerActionVersionIds = new Set<string>(
		githubV7ReviewerVerificationEvidence.actionVersionIds,
	);
	assert.ok(
		matrix
			.filter((item) => reviewerActionVersionIds.has(item.actionVersionId))
			.every(
				(item) =>
					item.actionVersionId.endsWith("@v7") &&
					item.evidence?.cleanup === "SUCCEEDED" &&
					item.evidence.runId === "35092020126-1" &&
					item.evidence.externalAccount === "329435106",
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
	for (const evidence of [
		{ ...githubV7VerificationEvidence, cleanup: "FAILED" as const },
		{ ...githubV7VerificationEvidence, provider: "foreign" },
		{ ...githubV7VerificationEvidence, providerReleaseId: "github-stale" },
	]) {
		assert.throws(
			() => capabilityVerificationMatrix(githubConnectionCatalog, evidence),
			/verification evidence does not match the catalog/,
		);
	}

	const mutableActionVersionIds = [
		...githubV7VerificationEvidence.actionVersionIds,
	];
	const mutableEvidence: LiveVerificationEvidence = {
		...githubV7VerificationEvidence,
		actionVersionIds: mutableActionVersionIds,
	};
	const immutableMatrix = capabilityVerificationMatrix(
		githubConnectionCatalog,
		mutableEvidence,
	);
	mutableEvidence.cleanup = "FAILED";
	mutableActionVersionIds.length = 0;
	const retainedEvidence = immutableMatrix.find(
		(item) => item.status === "LIVE_VERIFIED",
	)?.evidence;
	assert.equal(retainedEvidence?.cleanup, "SUCCEEDED");
	assert.equal(retainedEvidence?.actionVersionIds.length, 119);
	assert.ok(Object.isFrozen(retainedEvidence));
	assert.ok(Object.isFrozen(retainedEvidence?.actionVersionIds));
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
