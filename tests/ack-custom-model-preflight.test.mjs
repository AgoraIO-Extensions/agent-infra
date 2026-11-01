import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
	buildCustomMeasurementPod,
	buildCustomV3TurnRequest,
	CUSTOM_CAPACITY_SCOPE,
	capacityEvidenceHash,
	createCustomCapacityReceipt,
	runCustomCapacityMeasurement,
	validateCustomCapacityJob,
} from "../deploy/ack/custom-model-preflight.mts";

const job = {
	schemaVersion: 1,
	scope: CUSTOM_CAPACITY_SCOPE,
	sourceCommit: "62125de98b71413831b493a283f2b39359b8da9d",
	imageReference: `registry.example/custom@sha256:${"a".repeat(64)}`,
	imageDigest: `sha256:${"a".repeat(64)}`,
	platform: "linux/amd64",
	resourceProfileRef: "ack-small",
	resources: {
		requests: { cpu: "100m", memory: "128Mi" },
		limits: { cpu: "1", memory: "2Gi" },
	},
	kubeconfig: "/private/kubeconfig",
	namespace: "agent-infra",
	outputDirectory: "/private/output",
	principal: { kind: "application", id: "isolated-capacity" },
	grantIssuer: "capacity",
	workerId: "worker",
	grantKeyId: "capacity-v1",
	grantPublicKey:
		"-----BEGIN PUBLIC KEY-----\nsynthetic\n-----END PUBLIC KEY-----",
	operatorApprovalRef: "test-approved",
	modelOptionId: "custom:model",
	reasoningLevel: "medium",
	runtimeConfigVersion: "custom-v1",
};

test("custom jobs reject standard V4/Relay-key fields and accept exact source/image tuple", () => {
	assert.deepEqual(validateCustomCapacityJob(job), job);
	assert.throws(
		() => validateCustomCapacityJob({ ...job, executionSource: "eval" }),
		/UNBOUNDED/,
	);
	assert.throws(
		() =>
			validateCustomCapacityJob({
				...job,
				imageReference: "registry.example/custom:latest",
			}),
		/JOB_INVALID/,
	);
});

test("measurement Pod is isolated and has no Service, Ingress, or service account token", () => {
	const pod = buildCustomMeasurementPod(job, "capacity-probe", "owner-1");
	assert.equal(pod.kind, "Pod");
	assert.equal(pod.spec.automountServiceAccountToken, false);
	assert.equal(pod.spec.containers[0].image, job.imageReference);
	assert.equal(pod.spec.containers[0].resources.limits.cpu, "1");
	assert.equal(
		pod.spec.containers[0].securityContext.readOnlyRootFilesystem,
		true,
	);
	assert.equal(
		pod.spec.containers[0].env.some(
			(entry) =>
				entry.name === "AGENT_INFRA_RUNTIME_DRIVER" && entry.value === "acp",
		),
		true,
	);
	assert.equal("service" in pod, false);
	assert.equal("ingress" in pod, false);
});

test("V3 request is application-principal Grant V2 without V4 executionSource/keyBinding", () => {
	const keys = generateKeyPairSync("ed25519");
	const request = buildCustomV3TurnRequest({
		job,
		agentId: "agent",
		conversationId: "conversation",
		executionId: "execution",
		turnId: "turn",
		operationId: "operation",
		traceId: "trace",
		grantToken: "a.b.c",
	});
	assert.deepEqual(request.principal, {
		kind: "application",
		id: "isolated-capacity",
	});
	assert.equal(request.schemaVersion, 3);
	assert.equal(request.grant.schemaVersion, 2);
	assert.equal("executionSource" in request, false);
	assert.equal("keyBinding" in request, false);
	void keys;
});

test("receipt accepts only completed same-image/resource facts and produces evidence hash", () => {
	const receipt = createCustomCapacityReceipt({
		job,
		observed: {
			imageDigest: job.imageDigest,
			sourceCommit: job.sourceCommit,
			resources: job.resources,
			terminalStatus: "completed",
			replyMatched: true,
			submittedAt: 1000,
			completedAt: 2000,
			modelFacts: [{ phase: "completed", operationHash: "op" }],
			podUid: "pod-uid",
		},
	});
	assert.equal(receipt.scope, CUSTOM_CAPACITY_SCOPE);
	assert.equal(receipt.maximumConcurrentExecutions, 1);
	assert.equal(typeof capacityEvidenceHash(receipt), "string");
	assert.equal(capacityEvidenceHash(receipt).length, 64);
	assert.throws(
		() =>
			createCustomCapacityReceipt({
				job,
				observed: {
					...receipt,
					terminalStatus: "unknown",
					podUid: "pod-uid",
					modelFacts: [{ phase: "unknown", operationHash: "op" }],
				},
			}),
		/MEASUREMENT_INVALID/,
	);
});

test("producer seam verifies negative checks, same tuple, completion facts, and UID cleanup", async () => {
	const calls = [];
	const result = await runCustomCapacityMeasurement({
		job,
		podName: "capacity-probe",
		owner: "owner-1",
		request: {
			job,
			agentId: "agent",
			conversationId: "conversation",
			executionId: "execution",
			turnId: "turn",
			operationId: "operation",
			traceId: "trace",
			grantToken: "a.b.c",
		},
		transport: {
			createPod: async () => {
				calls.push("create");
				return {
					uid: "pod-uid",
					imageDigest: job.imageDigest,
					sourceCommit: job.sourceCommit,
					resources: job.resources,
				};
			},
			waitReady: async () => {
				calls.push("ready");
			},
			negativeChecks: async () => {
				calls.push("negative");
				return { wrongTokenRejected: true, crossBindingRejected: true };
			},
			submitV3: async () => {
				calls.push("submit");
				return { executionId: "execution", conversationId: "conversation" };
			},
			readTerminal: async () => {
				calls.push("terminal");
				return {
					status: "completed",
					replyMatched: true,
					submittedAt: 1000,
					completedAt: 2000,
					modelFacts: [{ phase: "completed", operationHash: "op" }],
				};
			},
			deletePod: async (uid) => {
				calls.push(`delete:${uid}`);
				return { deleted: true, uid };
			},
		},
	});
	assert.equal(result.status, "passed");
	assert.deepEqual(calls, [
		"create",
		"ready",
		"negative",
		"submit",
		"terminal",
		"delete:pod-uid",
	]);
	assert.equal(result.receipt.scope, CUSTOM_CAPACITY_SCOPE);
});

test("producer seam fails closed and cleans a created Pod when negative auth fails", async () => {
	const result = await runCustomCapacityMeasurement({
		job,
		podName: "capacity-probe",
		owner: "owner-1",
		request: {
			job,
			agentId: "agent",
			conversationId: "conversation",
			executionId: "execution",
			turnId: "turn",
			operationId: "operation",
			traceId: "trace",
			grantToken: "a.b.c",
		},
		transport: {
			createPod: async () => ({
				uid: "pod-uid",
				imageDigest: job.imageDigest,
				sourceCommit: job.sourceCommit,
				resources: job.resources,
			}),
			waitReady: async () => {},
			negativeChecks: async () => ({
				wrongTokenRejected: false,
				crossBindingRejected: true,
			}),
			submitV3: async () => {
				throw new Error("must-not-submit");
			},
			readTerminal: async () => {
				throw new Error("must-not-read");
			},
			deletePod: async (uid) => ({ deleted: true, uid }),
		},
	});
	assert.deepEqual(result, {
		status: "failed",
		failure: "CUSTOM_CAPACITY_NEGATIVE_CHECK_FAILED",
		cleanup: { deleted: true, uid: "pod-uid" },
	});
});
