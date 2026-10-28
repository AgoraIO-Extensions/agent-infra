#!/usr/bin/env node

import { createHmac, createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmod, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { templatePreflightValidationReceipt } from "./template-validation.mjs";

const runner = join(import.meta.dirname, "template-model-preflight-runner.mts");
const templates = new Set(["codex", "claude", "opencode", "pi"]);
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const sourcePattern = /^[a-f0-9]{40}$/u;
const namePattern = /^ack-preflight-[a-z0-9-]+$/u;
const privateFile = async (path, label) => {
	if (!isAbsolute(path)) throw new Error(`${label}_PATH_INVALID`);
	const stat = await lstat(path);
	if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
		throw new Error(`${label}_FILE_INVALID`);
	return readFile(path);
};
const run = (args, input) =>
	execFileSync("kubectl", args, {
		input,
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
	});

function validateJob(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JOB_INVALID");
	const allowed = new Set([
		"schemaVersion", "scope", "kubeconfig", "namespace", "sourceCommit", "templateId", "driver",
		"protocol", "operatorApprovalRef", "worktree", "outputDirectory", "imageReference", "imageDigest",
		"modelId", "modelOptionId", "reasoningLevel", "configurationRevision", "runtimeConfigVersion",
		"approvedRelayOrigin", "grantPrivateKeyFile", "runtimeServiceTokenFile", "relayKeyFile",
		"expectedResourceLimits", "expectedNodePrefix", "expectedReply", "placement", "imagePullSecret",
	]);
	if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("JOB_UNBOUNDED");
	if (
		value.schemaVersion !== 1 || value.scope !== "isolated-template-real-model" ||
		!isAbsolute(value.kubeconfig) || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.namespace) ||
		!sourcePattern.test(value.sourceCommit) || !templates.has(value.templateId) ||
		!new Set(["codex", "claude", "acp", "pi"]).has(value.driver) ||
		!new Set(["openai-responses-v1", "anthropic-messages-v1"]).has(value.protocol) ||
		!isAbsolute(value.worktree) || !isAbsolute(value.outputDirectory) ||
		!digestPattern.test(value.imageDigest) || !value.imageReference.endsWith(`@${value.imageDigest}`) ||
		typeof value.operatorApprovalRef !== "string" || !value.operatorApprovalRef ||
		typeof value.modelId !== "string" || !value.modelId || typeof value.modelOptionId !== "string" ||
		!value.modelOptionId || typeof value.reasoningLevel !== "string" || !value.reasoningLevel ||
		typeof value.configurationRevision !== "string" || !value.configurationRevision ||
		typeof value.runtimeConfigVersion !== "string" || !value.runtimeConfigVersion ||
		typeof value.approvedRelayOrigin !== "string" || !isAbsolute(value.grantPrivateKeyFile) ||
		!isAbsolute(value.runtimeServiceTokenFile) || !isAbsolute(value.relayKeyFile) ||
		!value.expectedResourceLimits || value.expectedResourceLimits.cpu !== "1" || value.expectedResourceLimits.memory !== "2Gi"
	)
		throw new Error("JOB_INVALID");
	const relay = new URL(value.approvedRelayOrigin);
	if (relay.protocol !== "https:" || relay.username || relay.password || relay.search || relay.hash)
		throw new Error("RELAY_ORIGIN_INVALID");
	const nodeSelector = value.placement?.nodeSelector;
	if (!nodeSelector || nodeSelector.type !== "virtual-kubelet") throw new Error("ECI_PLACEMENT_REQUIRED");
	return value;
}

async function waitForPort(port, process) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (process.exitCode !== null) throw new Error("PORT_FORWARD_FAILED");
		try {
			const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_000) });
			if (response.status === 200) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error("PORT_FORWARD_TIMEOUT");
}

async function main(inputPath) {
	const job = validateJob(JSON.parse(await privateFile(inputPath, "JOB")));
	await mkdir(job.outputDirectory, { recursive: true, mode: 0o700 });
	const owner = randomUUID();
	const name = `ack-preflight-${job.templateId}-${owner.slice(0, 8)}`;
	if (!namePattern.test(name)) throw new Error("POD_NAME_INVALID");
	const secretName = name;
	const kubeArgs = ["--kubeconfig", job.kubeconfig, "-n", job.namespace];
	const privateKey = createPrivateKey(await privateFile(job.grantPrivateKeyFile, "GRANT_KEY"));
	const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
	const serviceToken = (await privateFile(job.runtimeServiceTokenFile, "SERVICE_TOKEN")).toString().trim();
	if (!/^[\x21-\x7e]{1,8192}$/u.test(serviceToken)) throw new Error("SERVICE_TOKEN_INVALID");
	const attestation = createHmac("sha256", serviceToken)
		.update(`agent-infra-container-boundary-v1\0${name}`)
		.digest("base64url");
	const attestationFile = join(job.outputDirectory, `.attestation-${owner}`);
	await writeFile(attestationFile, attestation, { mode: 0o600 });
	const relayOrigin = new URL(job.approvedRelayOrigin).origin;
	const modelEndpoint = job.protocol === "openai-responses-v1" ? `${relayOrigin}/v1` : relayOrigin;
	const modelConfig = JSON.stringify({
		schemaVersion: 4,
		configVersion: job.runtimeConfigVersion,
		defaultModelOptionId: job.modelOptionId,
		defaultReasoningLevel: job.reasoningLevel,
		modelOptions: [{
			modelOptionId: job.modelOptionId,
			protocol: job.protocol,
			authentication: job.protocol === "openai-responses-v1" ? "bearer" : "api-key",
			endpoint: modelEndpoint,
			model: job.modelId,
			reasoningLevels: [job.reasoningLevel, "high"].filter((value, index, values) => values.indexOf(value) === index),
		}],
	});
	const pod = {
		apiVersion: "v1",
		kind: "Pod",
		metadata: { name, namespace: job.namespace, labels: {
			"agent-infra.validation-owner": owner,
			"agent-infra.validation-scope": job.scope,
		} },
		spec: {
			automountServiceAccountToken: false,
			restartPolicy: "Never",
			imagePullSecrets: job.imagePullSecret ? [{ name: job.imagePullSecret }] : [],
			nodeSelector: job.placement.nodeSelector,
			tolerations: job.placement.tolerations ?? [],
			securityContext: { fsGroup: 1000, runAsGroup: 1000, runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: "RuntimeDefault" } },
			containers: [{
				name: "runtime",
				image: job.imageReference,
				ports: [{ containerPort: 3003 }],
				resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: job.expectedResourceLimits },
				securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] }, readOnlyRootFilesystem: true },
				readinessProbe: { httpGet: { path: "/healthz", port: 3003 }, initialDelaySeconds: 2, periodSeconds: 3 },
				env: [
					{ name: "PORT", value: "3003" },
					{ name: "AGENT_INFRA_RUNTIME_DATA_DIR", value: "/var/lib/agent-runtime" },
					{ name: "AGENT_INFRA_RUNTIME_DRIVER", value: job.driver },
					{ name: "AGENT_INFRA_RUNTIME_AGENT_ID", value: `template-validation-agent-${job.templateId}-${owner.slice(0, 8)}` },
					{ name: "AGENT_INFRA_RUNTIME_WORKER_ID", value: "ack-template-validator" },
					{ name: "AGENT_INFRA_RUNTIME_GRANT_ISSUER", value: "ack-template-validation" },
					{ name: "AGENT_INFRA_RUNTIME_GRANT_KEY_ID", value: "ack-validation-v1" },
					{ name: "AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY", value: publicKey },
					{ name: "AGENT_INFRA_RUNTIME_MODEL_CONFIG", value: modelConfig },
					{ name: "AGENT_INFRA_RUNTIME_ISOLATION_MODE", value: "container-boundary" },
					{ name: "AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_ENABLED", value: "worker-v1" },
					{ name: "AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_SCOPE", value: name },
					{ name: "AGENT_INFRA_RUNTIME_SERVICE_TOKEN", valueFrom: { secretKeyRef: { name: secretName, key: "service-token" } } },
					{ name: "AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_ATTESTATION", valueFrom: { secretKeyRef: { name: secretName, key: "attestation" } } },
				],
				volumeMounts: [{ name: "data", mountPath: "/var/lib/agent-runtime" }, { name: "tmp", mountPath: "/tmp" }],
			}],
			volumes: [{ name: "data", emptyDir: {} }, { name: "tmp", emptyDir: {} }],
		},
	};
	if (job.driver === "codex") {
		const environment = new Map(pod.spec.containers[0].env.map((entry) => [entry.name, entry]));
		const attestationEntry = environment.get("AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_ATTESTATION");
		if (
			environment.get("AGENT_INFRA_RUNTIME_ISOLATION_MODE")?.value !== "container-boundary" ||
			environment.get("AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_ENABLED")?.value !== "worker-v1" ||
			environment.get("AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_SCOPE")?.value !== name ||
			attestationEntry?.valueFrom?.secretKeyRef?.name !== secretName ||
			attestationEntry?.valueFrom?.secretKeyRef?.key !== "attestation"
		)
			throw new Error("CODEX_BOUNDARY_PREFLIGHT_CONFIGURATION_INVALID");
	}
	let portForward;
	const generatedJob = join(job.outputDirectory, `.runner-job-${owner}.json`);
	try {
		const secret = run([...kubeArgs, "create", "secret", "generic", secretName, `--from-file=service-token=${job.runtimeServiceTokenFile}`, `--from-file=attestation=${attestationFile}`, "--dry-run=client", "-o", "json"]);
		run([...kubeArgs, "apply", "-f", "-"], secret);
		run([...kubeArgs, "create", "-f", "-"], JSON.stringify(pod));
		run([...kubeArgs, "wait", "--for=condition=Ready", `pod/${name}`, "--timeout=180s"]);
		const port = 35000 + Math.floor(Math.random() * 1000);
		portForward = spawn("kubectl", [...kubeArgs, "port-forward", `pod/${name}`, `${port}:3003`], { stdio: ["ignore", "pipe", "pipe"] });
		await waitForPort(port, portForward);
		const measurementPod = JSON.parse(run([...kubeArgs, "get", "pod", name, "-o", "json"]));
		const actualModuleHash = run([...kubeArgs, "exec", name, "--", "node", "-e", "console.log(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('/app/node_modules/@agent-infra/agent-runtime/dist/index.mjs')).digest('hex'))"]).trim();
		const runnerJob = {
			schemaVersion: 1, scope: job.scope, kubeconfig: job.kubeconfig, namespace: job.namespace,
			templateId: job.templateId, driver: job.driver, protocol: job.protocol,
			operatorApprovalRef: job.operatorApprovalRef, worktree: job.worktree, sourceCommit: job.sourceCommit,
			containerName: name, imageReference: job.imageReference, imageDigest: job.imageDigest,
			runtimeBaseUrl: `http://127.0.0.1:${port}/`, agentId: `template-validation-agent-${job.templateId}-${owner.slice(0, 8)}`,
			approvedRelayOrigin: job.approvedRelayOrigin, modelId: job.modelId, modelOptionId: job.modelOptionId,
			reasoningLevel: job.reasoningLevel, runtimeConfigVersion: job.runtimeConfigVersion,
			configurationRevision: job.configurationRevision, grantIssuer: "ack-template-validation",
			workerId: "ack-template-validator", grantKeyId: "ack-validation-v1",
			grantPrivateKeyFile: job.grantPrivateKeyFile, runtimeServiceTokenFile: job.runtimeServiceTokenFile,
			relayKeyFile: job.relayKeyFile, outputDirectory: job.outputDirectory,
			expectedResourceLimits: job.expectedResourceLimits, expectedNodePrefix: job.expectedNodePrefix ?? "virtual-kubelet-",
			expectedReply: job.expectedReply ?? "READY", runtimeModuleSha256: actualModuleHash,
		};
		await writeFile(generatedJob, JSON.stringify(runnerJob, null, 2), { mode: 0o600 });
		const child = spawn(process.execPath, ["--experimental-strip-types", runner, generatedJob], { stdio: "inherit" });
		const code = await new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (value) => resolve(value ?? 1));
		});
		if (code !== 0) throw new Error("TEMPLATE_PREFLIGHT_FAILED");
		const measured = JSON.parse(await privateFile(join(job.outputDirectory, "template-model-preflight.receipt.json"), "MEASUREMENT"));
		const observed = JSON.parse(run([...kubeArgs, "get", "pod", name, "-o", "json"]));
		if (observed.metadata.uid !== measurementPod.metadata.uid ||
			observed.metadata.labels["agent-infra.validation-owner"] !== owner ||
			observed.spec.containers[0].image !== job.imageReference ||
			observed.status.containerStatuses[0].restartCount !== 0 ||
			measured.imageDigest !== job.imageDigest || measured.sourceCommit !== job.sourceCommit ||
			measured.terminalStatus !== "completed" || measured.replyMatched !== true ||
			!Number.isSafeInteger(measured.submittedAt) || !Number.isSafeInteger(measured.validatedAt) ||
			measured.validatedAt < measured.submittedAt ||
			!Number.isSafeInteger(measured.modelOperationCount) || measured.modelOperationCount < 1)
			throw new Error("CAPACITY_MEASUREMENT_INVALID");
		await writeFile(join(job.outputDirectory, "template-model-validation.receipt.json"),
			JSON.stringify(templatePreflightValidationReceipt(measured)) + "\n",
			{ mode: 0o600, flag: "wx" });
		await writeFile(join(job.outputDirectory, "runtime-capacity.receipt.json"), JSON.stringify({
			schemaVersion: 1, scope: "ack-runtime-capacity", sourceCommit: job.sourceCommit,
			imageDigest: job.imageDigest, observedResources: observed.spec.containers[0].resources,
			maximumConcurrentExecutions: 1, terminalStatus: "completed", replyMatched: true,
			modelOperationCount: measured.modelOperationCount,
			submittedAt: measured.submittedAt, completedAt: measured.validatedAt,
		}) + "\n", { mode: 0o600, flag: "wx" });
		process.stdout.write(JSON.stringify({ schemaVersion: 1, kind: "ack-template-preflight", templateId: job.templateId, status: "passed" }) + "\n");
	} finally {
		portForward?.kill("SIGTERM");
		await unlink(generatedJob).catch(() => {});
		await unlink(attestationFile).catch(() => {});
		try { run([...kubeArgs, "delete", "pod", name, "--ignore-not-found", "--wait=false"]); } catch {}
		try { run([...kubeArgs, "delete", "secret", secretName, "--ignore-not-found"]); } catch {}
	}
}

try {
	const path = process.argv[2];
	if (!path) throw new Error("JOB_REQUIRED");
	await main(path);
} catch (error) {
	process.stderr.write(`${error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message) ? error.message : "ACK_TEMPLATE_PREFLIGHT_FAILED"}\n`);
	process.exitCode = 1;
}
