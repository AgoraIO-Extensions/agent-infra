import assert from "node:assert/strict";
import { test } from "node:test";
import { transitionExecutorInstanceV2 } from "../packages/platform-core/dist/index.mjs";
import {
	executorInstanceRollbackCompatibilityV2,
	readExecutorInstanceRollbackV2,
} from "../packages/platform-store/src/executor-instance-rollback-preflight.mjs";

const authority = {
	namespace: "fixture",
	podName: "sandbox-fixture",
	sandboxId: "fixture",
	generation: 1,
	resourceFence: 2,
	configurationRevision: 3,
	imageDigest: `sha256:${"a".repeat(64)}`,
	now: 1000,
	hasUnresolvedExecution: false,
	proofVerified: false,
};
const prepared = () =>
	transitionExecutorInstanceV2({
		state: null,
		mutation: {
			kind: "prepare",
			bindingDigest: "b".repeat(64),
			configurationVersion: "configuration-three",
			timeoutMs: 10000,
			approval: {
				schemaVersion: 2,
				imageDigest: `registry.example/runtime@${authority.imageDigest}`,
				verificationRef: "verified-contract",
			},
		},
		authority,
	}).state;
test("rollback rejects any pending V2 scope and unsettled producer lease", () => {
	const state = prepared();
	assert.equal(
		executorInstanceRollbackCompatibilityV2([{ state }], "fixture", 1)
			.compatible,
		false,
	);
	assert.equal(
		executorInstanceRollbackCompatibilityV2([{ state }], "fixture", 2)
			.compatible,
		true,
	);
	assert.equal(
		executorInstanceRollbackCompatibilityV2([], "fixture", 1, 1).compatible,
		false,
	);
	assert.equal(
		executorInstanceRollbackCompatibilityV2([], "fixture", 1, 0).compatible,
		true,
	);
	assert.throws(() =>
		executorInstanceRollbackCompatibilityV2(
			[{ state: { ...state, sequence: 0 } }],
			"fixture",
			1,
		),
	);
	assert.throws(() =>
		executorInstanceRollbackCompatibilityV2(
			[{ state: { schemaVersion: 9 } }],
			"fixture",
			1,
		),
	);
});
test("inventory uses a read-only transaction and orders concurrent producers before its snapshot", async () => {
	const calls = [];
	const transaction = async (parts) => {
		const sql = parts.join("?");
		calls.push(sql);
		return sql.includes("distinct on")
			? []
			: sql.includes("count(*)")
				? [{ count: 0 }]
				: [];
	};
	const client = {
		begin: async (mode, read) => {
			assert.equal(mode, "read only");
			return read(transaction);
		},
	};
	assert.equal(
		(await readExecutorInstanceRollbackV2(client, "fixture", 1)).compatible,
		true,
	);
	assert.ok(calls[2].includes("pg_advisory_xact_lock"));
	assert.ok(calls[3].includes("sequence"));
	assert.ok(
		calls.every(
			(sql) => !/\b(insert|update|delete|drop|truncate)\b/i.test(sql),
		),
	);
});
