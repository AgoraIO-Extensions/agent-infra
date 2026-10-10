import assert from "node:assert/strict";
import test from "node:test";
import {
	applyReviewedMigrations,
	migrationJob,
	validateMigrationPlan,
	validateMigrationReceipt,
	validateMigrationReview,
} from "../deploy/connection-reviewed-migrations.mjs";
import { shanghai } from "../deploy/connection-shanghai-release.mjs";

const sha = "a".repeat(40);
const plan = { sha, prNumber: 1646, hashes: ["h1", "h2"] };
const before = { entries: [{ tag: "0000_connection", when: 1 }] };
const after = {
	entries: [
		...before.entries,
		{ tag: "0037_provider_release_lifecycle", when: 2 },
	],
};
const changes = [
	["A", "migrations/connection/0037_provider_release_lifecycle.sql"],
	["M", "migrations/connection/meta/_journal.json"],
];
const api = {
	spec: {
		template: {
			spec: {
				nodeSelector: { machine: "fixture" },
				containers: [
					{
						name: "api",
						env: [{ name: "PROVIDER_SECRET", value: "must-not-copy" }],
						volumeMounts: [
							{ name: "ca", mountPath: "/etc/connection-rds", readOnly: true },
						],
					},
				],
				volumes: [
					{ name: "ca", configMap: { name: shanghai.caConfigMap } },
					{ name: "private-secret", secret: {} },
				],
			},
		},
	},
};

test("reviewed mode requires a merged PR and append-only schema changes without rechecking CI/review", () => {
	assert.deepEqual(validateMigrationPlan(before, after, changes), [
		changes[0][1],
	]);
	for (const bad of [
		[...changes, ["M", "migrations/connection/0000_connection.sql"]],
		changes.slice(1),
	])
		assert.throws(() => validateMigrationPlan(before, after, bad));
	assert.throws(() =>
		validateMigrationPlan(
			before,
			{ entries: [{ tag: "rewritten" }, after.entries[1]] },
			changes,
		),
	);
	const pr = { state: "MERGED", mergeCommit: { oid: sha }, headRefOid: sha };
	validateMigrationReview(pr);
	validateMigrationReview({ ...pr, statusCheckRollup: [] });
	validateMigrationReview({
		...pr,
		statusCheckRollup: ["CI", "review"].map((name) => ({
			name,
			status: "COMPLETED",
			conclusion: "FAILURE",
		})),
	});
	assert.throws(() => validateMigrationReview({ ...pr, state: "OPEN" }));
	assert.throws(() =>
		validateMigrationReview({ ...pr, headRefOid: "invalid" }),
	);
	assert.throws(() => validateMigrationReview({ ...pr, mergeCommit: null }));
});

test("migration manifest isolates database/TLS, avoids API service selectors and has no retry", () => {
	const job = migrationJob("connection-v0.0.83", plan, api, shanghai);
	assert.equal(job.spec.backoffLimit, 0);
	assert.equal(job.spec.activeDeadlineSeconds, 300);
	assert.equal(job.spec.template.spec.automountServiceAccountToken, false);
	assert.deepEqual(
		job.spec.template.spec.containers[0].env.map((entry) => entry.name),
		["DATABASE_URL", "NODE_EXTRA_CA_CERTS"],
	);
	assert.equal(job.spec.template.spec.volumes.length, 1);
	assert.equal(
		job.spec.template.metadata.labels["app.kubernetes.io/name"],
		"connection-migration",
	);
	assert.deepEqual(job.spec.template.spec.containers[0].command, [
		"node",
		"dist/bootstrap-production.mjs",
	]);
	assert.ok(!JSON.stringify(job).includes("must-not-copy"));
});

test("completed migration receipt is reusable without submitting a new Job", async () => {
	const job = migrationJob("connection-v0.0.83", plan, api, shanghai);
	const completed = { ...job, status: { succeeded: 1 } };
	let creates = 0;
	const kube = (...args) =>
		args.includes("logs")
			? JSON.stringify({ migrationReceiptVersion: 1, hashes: plan.hashes })
			: JSON.stringify(completed);
	await applyReviewedMigrations(kube, job, plan, () => {
		creates++;
	});
	assert.equal(creates, 0);
	assert.throws(() =>
		validateMigrationReceipt(
			{ migrationReceiptVersion: 1, hashes: ["wrong"] },
			plan,
		),
	);
	await assert.rejects(() =>
		applyReviewedMigrations(
			() => JSON.stringify({ ...completed, status: { failed: 1 } }),
			job,
			plan,
			() => {
				creates++;
			},
		),
	);
	await assert.rejects(() =>
		applyReviewedMigrations(
			() =>
				JSON.stringify({
					...completed,
					metadata: {
						annotations: { "connection/source-sha": "b".repeat(40) },
					},
				}),
			job,
			plan,
			() => {
				creates++;
			},
		),
	);
	assert.equal(creates, 0);
});
