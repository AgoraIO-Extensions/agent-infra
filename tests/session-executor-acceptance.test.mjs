import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { executorAcceptance } from "../deploy/ack/session-executor-acceptance.mjs";

const namespace = "isolated-acceptance";
const plan = "executor-plan-stop-v1";
const run = "executor-run-stale-fence";
const planUid = "plan-original";
const imageDigest = `sha256:${"a".repeat(64)}`;
const target = { sandbox: "sandbox-original", generation: 2, resourceFence: 3 };
const reference = `${namespace}/${plan}`;

function fixture(overrides = {}) {
	const fixtureSource = JSON.stringify({
		schemaVersion: 1,
		scenario: "stale-fence",
		sandbox: target.sandbox,
		podUid: "original-pod",
		jobSpec: {
			backoffLimit: 0,
			activeDeadlineSeconds: 1,
			template: {
				spec: {
					restartPolicy: "Never",
					containers: [
						{ name: "probe", image: `registry.example/runtime@${imageDigest}` },
					],
				},
			},
		},
	});
	const receipt = {
		schemaVersion: 1,
		run,
		scenario: "stale-fence",
		target,
		imageDigest,
		startupRef: "original-start",
		podUid: "original-pod",
		deadline: 1800,
		firstRejectedAt: 1600,
		reason: "stale-fence",
		ready: false,
		toolAdmitted: false,
		proof: "unproven",
		stop: {
			id: "stop-original",
			executionId: "execution-original",
			confirmationDeadline: 1700,
			barrier: "sealed",
			occupancy: "retained",
			nextTurn: "rejected",
		},
		...overrides,
	};
	const planData = {
		schemaVersion: 1,
		imageDigest,
		startsAt: 1000,
		expiresAt: 4000,
		fixtures: [
			{
				scenario: "stale-fence",
				sandbox: target.sandbox,
				sha256: `sha256:${createHash("sha256").update(fixtureSource).digest("hex")}`,
			},
		],
		targets: [target, { ...target, sandbox: "sandbox-second" }],
	};
	const calls = [];
	const get = (ns, name) => {
		calls.push([ns, name]);
		assert.equal(ns, namespace);
		const getPlan = name === plan;
		const ownerReferences = getPlan
			? {}
			: {
					ownerReferences: [{ kind: "ConfigMap", uid: planUid, name: plan }],
				};
		return {
			kind: "ConfigMap",
			immutable: true,
			metadata: {
				name,
				namespace,
				uid: getPlan ? planUid : "run-original",
				...ownerReferences,
			},
			data: getPlan
				? { "plan.json": JSON.stringify(planData) }
				: name.startsWith("executor-fixture-")
					? { "fixture.json": fixtureSource }
					: { "receipt.json": JSON.stringify(receipt) },
		};
	};
	return { get, calls, receipt };
}

test("lists the approved plan without requesting any receipt or Pod", () => {
	const { get, calls } = fixture();
	const listed = executorAcceptance(["list", "--plan", reference], get);
	assert.deepEqual(calls, [[namespace, plan]]);
	assert.deepEqual(listed.targets[0], target);
	assert.deepEqual(listed.scenarios, ["stale-fence"]);
});

test("only projects the original, explicitly named immutable run", () => {
	const { get, calls, receipt } = fixture();
	assert.deepEqual(
		executorAcceptance(["read", "--plan", reference, "--run", run], get),
		receipt,
	);
	assert.deepEqual(calls, [
		[namespace, plan],
		[namespace, run],
	]);
});

test("rejects stale scope and unrecognized fields without returning the raw receipt", () => {
	for (const wrong of [
		{ target: { ...target, resourceFence: 2 } },
		{ target: { ...target, sandbox: "sandbox-not-approved" } },
		{ untrustedExtraField: "synthetic-not-for-output" },
	]) {
		assert.throws(
			() =>
				executorAcceptance(
					["read", "--plan", reference, "--run", run],
					fixture(wrong).get,
				),
			/SESSION_EXECUTOR_ACCEPTANCE_EVIDENCE_INVALID/,
		);
	}
});

test("starts only the approved fixture for the current Pod UID and fence", () => {
	const cases = [
		{ actualFence: 2, actualUid: "original-pod", expectedWrites: 0 },
		{ actualFence: 3, actualUid: "replacement-pod", expectedWrites: 0 },
		{ actualFence: 3, actualUid: "original-pod", expectedWrites: 1 },
	];
	for (const input of cases) {
		const operations = [];
		const cluster = (ns, argv, data) => {
			operations.push(argv[0]);
			assert.equal(ns, namespace);
			if (argv[0] === "get")
				return {
					kind: "Pod",
					metadata: {
						namespace,
						name: target.sandbox,
						uid: input.actualUid,
						labels: {
							"agent-infra.agora.io/managed": "session-sandbox-v1",
							"agent-infra.agora.io/sandbox-id": "original",
							"agent-infra.agora.io/generation": "2",
						},
					},
					spec: {
						containers: [
							{
								name: "codex-session-executor",
								image: `registry.example/runtime@${imageDigest}`,
								env: [
									{
										name: "AGENT_INFRA_CODEX_SESSION_EXECUTOR_BINDING",
										value: JSON.stringify({
											namespace,
											podName: target.sandbox,
											sessionGeneration: 2,
											resourceFence: input.actualFence,
										}),
									},
								],
							},
						],
					},
				};
			const job = JSON.parse(data);
			assert.equal(job.metadata.ownerReferences[0].uid, planUid);
			return { ...job, metadata: { ...job.metadata, uid: "job-original" } };
		};
		const invoke = () =>
			executorAcceptance(
				[
					"run",
					"--plan",
					reference,
					"--scenario",
					"stale-fence",
					"--target",
					target.sandbox,
				],
				fixture().get,
				cluster,
				() => 1500,
			);
		if (input.expectedWrites === 0) assert.throws(invoke);
		else assert.equal(invoke().evidence, "pending");
		assert.equal(
			operations.filter((operation) => operation === "create").length,
			input.expectedWrites,
		);
	}
});
