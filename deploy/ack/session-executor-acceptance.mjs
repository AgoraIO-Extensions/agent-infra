#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const scenarios = Object.freeze([
	"role-mismatch",
	"cross-pod-projection",
	"stale-epoch",
	"stale-fence",
	"expired-bootstrap",
	"duplicate-consumption",
	"missing-projection",
	"lost-consumption-restart",
	"same-uid-isolation",
	"stop-after-bootstrap-expiry",
	"control-renewal-unavailable",
]);

const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/;
const sha = /^sha256:[0-9a-f]{64}$/;
const integer = (value) => Number.isSafeInteger(value) && value > 0;

function invalid() {
	throw new Error("SESSION_EXECUTOR_ACCEPTANCE_EVIDENCE_INVALID");
}

function exact(value, keys) {
	return value !== null && typeof value === "object" && !Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key));
}

function requiredReference(value, prefix) {
	if (typeof value !== "string" || !dnsLabel.test(value) || !value.startsWith(prefix))
		invalid();
	return value;
}

function kubectl(namespace, args, stdin) {
	const kubeconfig = process.env.ACK_KUBECONFIG;
	if (!kubeconfig) throw new Error("ACK_KUBECONFIG_REQUIRED");
	const bytes = execFileSync("kubectl", [
		"--kubeconfig", kubeconfig, "--namespace", namespace, ...args,
	], {
		encoding: "utf8",
		input: stdin,
		maxBuffer: 256 * 1024,
		timeout: 10_000,
		stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
	});
	if (args[0] === "logs")
		return bytes.split("\n").flatMap((line) => {
			try {
				const value = JSON.parse(line);
				return ["CODEX_EXECUTOR_DRAIN_VERIFIED", "CODEX_EXECUTOR_DRAIN_SEALED",
					"CODEX_EXECUTOR_TERMINAL_COMMITTED"].includes(value?.code) ? [value] : [];
			} catch {
				return [];
			}
		});
	return bytes.trim() ? JSON.parse(bytes) : null;
}

function readConfigMap(namespace, name, optional = false) {
	return kubectl(namespace, ["get", "configmap", name, "-o", "json",
		...(optional ? ["--ignore-not-found=true"] : [])]);
}

function input(map, namespace, name, key) {
	if (map?.kind !== "ConfigMap" || map.immutable !== true ||
		map.metadata?.name !== name || map.metadata.namespace !== namespace ||
		typeof map.metadata.uid !== "string" || !identifier.test(map.metadata.uid) ||
		typeof map.data?.[key] !== "string" || map.data[key].length > 32_768)
		invalid();
	return JSON.parse(map.data[key]);
}

export function executorAcceptance(options, get = readConfigMap, cluster = kubectl, now = Date.now) {
	const [command, planOption, reference, option, value, targetOption, sandbox] = options;
	if (planOption !== "--plan" ||
		!(command === "list" && options.length === 3 ||
			command === "read" && option === "--run" && options.length === 5 ||
			command === "run" && option === "--scenario" && targetOption === "--target" && options.length === 7))
		invalid();
	const [namespace, name, ...rest] = reference?.split("/") ?? [];
	if (rest.length || !namespace || !dnsLabel.test(namespace)) invalid();
	requiredReference(name, "executor-plan-");
	const planObject = get(namespace, name);
	const plan = input(planObject, namespace, name, "plan.json");
	if (!exact(plan, ["schemaVersion", "imageDigest", "startsAt", "expiresAt", "targets", "fixtures"]) ||
		plan.schemaVersion !== 1 || !sha.test(plan.imageDigest) ||
		!integer(plan.startsAt) || !integer(plan.expiresAt) || plan.startsAt >= plan.expiresAt ||
		!Array.isArray(plan.targets) || plan.targets.length !== 2 ||
		plan.targets.some((target) =>
			!exact(target, ["sandbox", "generation", "resourceFence"]) ||
			typeof target.sandbox !== "string" || !dnsLabel.test(target.sandbox) ||
			!target.sandbox.startsWith("sandbox-") ||
			!integer(target.generation) || !integer(target.resourceFence)) ||
		plan.targets[0].sandbox === plan.targets[1].sandbox ||
		!Array.isArray(plan.fixtures) || plan.fixtures.length > 2 * scenarios.length ||
		plan.fixtures.some((fixture) =>
			!exact(fixture, ["scenario", "sandbox", "sha256"]) ||
			!scenarios.includes(fixture.scenario) || !sha.test(fixture.sha256) ||
			!plan.targets.some((target) => target.sandbox === fixture.sandbox)) ||
		new Set(plan.fixtures.map((fixture) => `${fixture.sandbox}/${fixture.scenario}`)).size !== plan.fixtures.length)
		invalid();
	if (command === "list")
		return {
			namespace,
			plan: name,
			...plan,
			scenarios: scenarios.filter((scenario) =>
				plan.fixtures.some((fixture) => fixture.scenario === scenario)),
		};
	if (command === "run") {
		const target = plan.targets.find((entry) => entry.sandbox === sandbox);
		const time = now();
		const approved = plan.fixtures.find((entry) => entry.sandbox === sandbox && entry.scenario === value);
		if (!target || !approved || time < plan.startsAt || time >= plan.expiresAt)
			invalid();
		const fixtureId = createHash("sha256")
			.update(JSON.stringify([planObject.metadata.uid, target.sandbox, value]))
			.digest("hex").slice(0, 24);
		return runFixture(cluster, get, { namespace, name, plan, planUid: planObject.metadata.uid,
			target, scenario: value, fixtureId, approved, now });
	}
	const run = value;
	requiredReference(run, "executor-run-");
	const receiptObject = get(namespace, run, true);
	if (receiptObject === null) return { schemaVersion: 1, namespace, run, evidence: "pending" };
	const receipt = input(receiptObject, namespace, run, "receipt.json");
	const ownerRefs = receiptObject.metadata.ownerReferences;
	if (!Array.isArray(ownerRefs) || ownerRefs.length !== 1 ||
		ownerRefs[0].kind !== "ConfigMap" || ownerRefs[0].name !== name ||
		ownerRefs[0].uid !== planObject.metadata.uid)
		invalid();
	if (!exact(receipt, ["schemaVersion", "run", "scenario", "target", "imageDigest",
		"startupRef", "podUid", "deadline", "firstRejectedAt", "reason", "ready",
		"toolAdmitted", "proof", "stop"]) ||
		receipt.schemaVersion !== 1 || receipt.run !== run ||
		!scenarios.includes(receipt.scenario) || receipt.imageDigest !== plan.imageDigest ||
		!plan.fixtures.some((fixture) => fixture.scenario === receipt.scenario && fixture.sandbox === receipt.target?.sandbox) ||
		!exact(receipt.target, ["sandbox", "generation", "resourceFence"]) ||
		!plan.targets.some((target) => target.sandbox === receipt.target.sandbox &&
			target.generation === receipt.target.generation &&
			target.resourceFence === receipt.target.resourceFence) ||
		typeof receipt.startupRef !== "string" || !identifier.test(receipt.startupRef) ||
		!(receipt.podUid === null || typeof receipt.podUid === "string" && identifier.test(receipt.podUid)) ||
		!integer(receipt.deadline) || receipt.deadline > plan.expiresAt ||
		!(receipt.firstRejectedAt === null ||
			integer(receipt.firstRejectedAt) && receipt.firstRejectedAt >= plan.startsAt && receipt.firstRejectedAt <= plan.expiresAt) ||
		!["confirmed", "unproven", "unavailable", ...scenarios].includes(receipt.reason) ||
		![true, false, null].includes(receipt.ready) ||
		![true, false, null].includes(receipt.toolAdmitted) ||
		!["confirmed", "unproven", "not-applicable"].includes(receipt.proof))
		invalid();
	const stop = receipt.stop;
	if (stop !== null && (!exact(stop, ["id", "executionId", "confirmationDeadline",
		"barrier", "occupancy", "nextTurn"]) ||
		typeof stop.id !== "string" || !identifier.test(stop.id) ||
		typeof stop.executionId !== "string" || !identifier.test(stop.executionId) ||
		!integer(stop.confirmationDeadline) ||
		!["sealed", "unproven"].includes(stop.barrier) ||
		!["retained", "released", "unproven"].includes(stop.occupancy) ||
		!["accepted", "rejected", "unproven"].includes(stop.nextTurn)))
		invalid();
	if (receipt.proof === "confirmed") {
		const evidence = stop && readOriginalDrainEvidence(cluster, namespace, plan, receipt);
		if (!evidence) return { schemaVersion: 1, namespace, run, evidence: "pending" };
		return { ...receipt, drainEvidence: evidence };
	}
	return receipt;
}

function readOriginalDrainEvidence(cluster, namespace, plan, receipt) {
	const { stop, target, podUid } = receipt;
	if (!podUid) return null;
	const original = () => {
		const pod = cluster(namespace, ["get", "pod", target.sandbox, "-o", "json"]);
		return pod?.kind === "Pod" && pod.metadata?.uid === podUid &&
			pod.metadata.name === target.sandbox && pod.metadata.namespace === namespace;
	};
	const keys = ["schemaVersion", "code", "podUid", "executionId", "stopRequestId",
		"generation", "resourceFence", "epoch", "stopFence", "digest"];
	const matchesStop = (item) =>
		item?.schemaVersion === 1 && item.podUid === podUid && item.executionId === stop.executionId &&
		item.stopRequestId === stop.id && item.generation === target.generation &&
		item.resourceFence === target.resourceFence;
	const consistent = (entries) => {
		const first = entries[0];
		return first && entries.every((entry) => JSON.stringify(entry) === JSON.stringify(first))
			? first : null;
	};
	try {
		if (!original()) return null;
		const read = (container) => cluster(namespace, [
			"logs", target.sandbox, `--container=${container}`,
			`--since-time=${new Date(plan.startsAt).toISOString()}`,
		]);
		const executor = read("codex-session-executor");
		const runtime = read("runtime");
		if (!Array.isArray(executor) || !Array.isArray(runtime) || !original()) return null;
		const seal = consistent(executor.filter((item) =>
			matchesStop(item) && item.code === "CODEX_EXECUTOR_DRAIN_SEALED",
		));
		if (!exact(seal, [...keys, "groupIds"]) || !/^[a-f0-9-]{36}$/.test(seal.epoch) ||
			!integer(seal.stopFence) || !/^[a-f0-9]{64}$/.test(seal.digest) ||
			!Array.isArray(seal.groupIds) || seal.groupIds.length < 1 || seal.groupIds.length > 4096 ||
			new Set(seal.groupIds).size !== seal.groupIds.length ||
			!seal.groupIds.every((id) => typeof id === "string" && /^[a-f0-9]{64}$/.test(id)))
			return null;
		const committed = consistent(runtime.filter((item) =>
			matchesStop(item) && item.code === "CODEX_EXECUTOR_TERMINAL_COMMITTED",
		));
		const proof = consistent(runtime.filter((item) =>
			matchesStop(item) && item.code === "CODEX_EXECUTOR_DRAIN_VERIFIED",
		));
		const sameSeal = (item) => ["epoch", "stopFence", "digest"].every((key) => item[key] === seal[key]);
		if (!exact(committed, [...keys, "occurredAt"]) || !sameSeal(committed) ||
			!integer(committed.occurredAt) || committed.occurredAt > plan.expiresAt ||
			!exact(proof, [...keys, "verifiedAt", "groups"]) || !sameSeal(proof) ||
			!integer(proof.verifiedAt) || proof.verifiedAt < plan.startsAt ||
			proof.verifiedAt > committed.occurredAt || proof.verifiedAt > stop.confirmationDeadline ||
			!Array.isArray(proof.groups) || proof.groups.length !== seal.groupIds.length ||
			!proof.groups.every((group, index) =>
				exact(group, ["id", "exitedAt"]) && group.id === seal.groupIds[index] &&
				integer(group.exitedAt) && group.exitedAt >= plan.startsAt && group.exitedAt <= proof.verifiedAt))
			return null;
		return { ...proof, terminalAt: committed.occurredAt };
	} catch {
		return null;
	}
}

/** The deployment owner supplies immutable, versioned fixtures in the approved namespace. */
function runFixture(cluster, get, scope) {
	const { namespace, name, plan, planUid, target, scenario, fixtureId, approved, now } = scope;
	const prefix = "agent-infra.agora.io/";
	const run = `executor-run-${fixtureId}`;
	const fixtureName = `executor-fixture-${fixtureId}`;
	const fixtureMap = get(namespace, fixtureName);
	const fixture = input(fixtureMap, namespace, fixtureName, "fixture.json");
	const fixtureHash = `sha256:${createHash("sha256").update(fixtureMap.data["fixture.json"]).digest("hex")}`;
	const owner = fixtureMap.metadata.ownerReferences;
	if (fixtureHash !== approved.sha256 || !Array.isArray(owner) || owner.length !== 1 ||
		owner[0].kind !== "ConfigMap" || owner[0].name !== name || owner[0].uid !== planUid ||
		!exact(fixture, ["schemaVersion", "scenario", "sandbox", "podUid", "jobSpec"]) ||
		fixture.schemaVersion !== 1 || fixture.scenario !== scenario || fixture.sandbox !== target.sandbox ||
		typeof fixture.podUid !== "string" || !identifier.test(fixture.podUid))
		invalid();
	const original = cluster(namespace, ["get", "pod", target.sandbox, "-o", "json"]);
	const metadata = original.metadata;
	if (original.kind !== "Pod" || metadata?.name !== target.sandbox ||
		metadata.namespace !== namespace || metadata.uid !== fixture.podUid ||
		metadata.deletionTimestamp !== undefined ||
		metadata.labels?.[`${prefix}managed`] !== "session-sandbox-v1" ||
		metadata.labels?.[`${prefix}sandbox-id`] !== target.sandbox.slice("sandbox-".length) ||
		metadata.labels?.[`${prefix}generation`] !== String(target.generation))
		invalid();
	const runner = original.spec?.containers?.find((container) => container.name === "codex-session-executor");
	const bindingValue = runner?.env?.find((entry) => entry.name === "AGENT_INFRA_CODEX_SESSION_EXECUTOR_BINDING")?.value;
	const binding = typeof bindingValue === "string" ? JSON.parse(bindingValue) : undefined;
	if (binding?.resourceFence !== target.resourceFence || binding.sessionGeneration !== target.generation ||
		binding.namespace !== namespace || binding.podName !== target.sandbox ||
		!runner.image?.endsWith(`@${plan.imageDigest}`))
		invalid();
	const job = fixture.jobSpec;
	const template = job?.template?.spec;
	if (!template || template.hostNetwork === true || template.hostPID === true ||
		template.hostIPC === true || template.restartPolicy !== "Never" || job.backoffLimit !== 0 ||
		!integer(job.activeDeadlineSeconds) || job.activeDeadlineSeconds > 900 ||
		!Array.isArray(template.containers) || template.containers.length !== 1 ||
		!template.containers[0].image?.endsWith(`@${plan.imageDigest}`) ||
		template.containers[0].securityContext?.privileged === true ||
		(template.volumes ?? []).some((volume) => volume.hostPath !== undefined) ||
		now() + job.activeDeadlineSeconds * 1000 > plan.expiresAt)
		invalid();
	const created = cluster(namespace, ["create", "-f", "-", "-o", "json"], JSON.stringify({
		apiVersion: "batch/v1",
		kind: "Job",
		metadata: {
			namespace, name: run,
			ownerReferences: [{ apiVersion: "v1", kind: "ConfigMap", name, uid: planUid }],
			annotations: {
				[`${prefix}executor-scenario`]: scenario,
				[`${prefix}executor-target-pod-uid`]: fixture.podUid,
				[`${prefix}executor-target-fence`]: String(target.resourceFence),
			},
		},
		spec: job,
	}));
	if (created.kind !== "Job" || created.metadata?.name !== run ||
		created.metadata.namespace !== namespace || !identifier.test(created.metadata.uid))
		invalid();
	return { schemaVersion: 1, namespace, run, scenario, target, evidence: "pending" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		process.stdout.write(`${JSON.stringify(executorAcceptance(process.argv.slice(2)))}\n`);
	} catch {
		process.stderr.write("SESSION_EXECUTOR_ACCEPTANCE_EVIDENCE_UNAVAILABLE\n");
		process.exitCode = 1;
	}
}
