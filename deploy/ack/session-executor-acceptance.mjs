#!/usr/bin/env node
import { execFileSync } from "node:child_process";
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

function readConfigMap(namespace, name) {
	const kubeconfig = process.env.ACK_KUBECONFIG;
	if (!kubeconfig) throw new Error("ACK_KUBECONFIG_REQUIRED");
	const bytes = execFileSync("kubectl", [
		"--kubeconfig", kubeconfig,
		"--namespace", namespace,
		"get", "configmap", name, "-o", "json",
	], { encoding: "utf8", maxBuffer: 256 * 1024, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
	return JSON.parse(bytes);
}

function input(map, namespace, name, key) {
	if (map?.kind !== "ConfigMap" || map.immutable !== true ||
		map.metadata?.name !== name || map.metadata.namespace !== namespace ||
		typeof map.metadata.uid !== "string" || !identifier.test(map.metadata.uid) ||
		typeof map.data?.[key] !== "string" || map.data[key].length > 32_768)
		invalid();
	return JSON.parse(map.data[key]);
}

export function readAcceptance(options, get = readConfigMap) {
	const [command, planOption, reference, runOption, run, ...extra] = options;
	if (extra.length !== 0 || planOption !== "--plan" ||
		!(command === "list" && options.length === 3 ||
			command === "read" && runOption === "--run" && options.length === 5))
		invalid();
	const [namespace, name, ...rest] = reference?.split("/") ?? [];
	if (rest.length || !namespace || !dnsLabel.test(namespace)) invalid();
	requiredReference(name, "executor-plan-");
	const planObject = get(namespace, name);
	const plan = input(planObject, namespace, name, "plan.json");
	if (!exact(plan, ["schemaVersion", "imageDigest", "startsAt", "expiresAt", "targets"]) ||
		plan.schemaVersion !== 1 || !sha.test(plan.imageDigest) ||
		!integer(plan.startsAt) || !integer(plan.expiresAt) || plan.startsAt >= plan.expiresAt ||
		!Array.isArray(plan.targets) || plan.targets.length !== 2 ||
		plan.targets.some((target) =>
			!exact(target, ["sandbox", "generation", "resourceFence"]) ||
			typeof target.sandbox !== "string" || !dnsLabel.test(target.sandbox) ||
			!target.sandbox.startsWith("sandbox-") ||
			!integer(target.generation) || !integer(target.resourceFence)) ||
		plan.targets[0].sandbox === plan.targets[1].sandbox)
		invalid();
	if (command === "list")
		return { namespace, plan: name, ...plan, scenarios };
	requiredReference(run, "executor-run-");
	const receiptObject = get(namespace, run);
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
	return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		process.stdout.write(`${JSON.stringify(readAcceptance(process.argv.slice(2)))}\n`);
	} catch {
		process.stderr.write("SESSION_EXECUTOR_ACCEPTANCE_EVIDENCE_UNAVAILABLE\n");
		process.exitCode = 1;
	}
}
