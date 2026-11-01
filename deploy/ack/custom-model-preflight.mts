import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalRuntimeRequestSigningPayload } from "../../packages/contracts/src/runtime/request-signing.ts";

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const sourcePattern = /^[a-f0-9]{40}$/u;
const idPattern = /^[A-Za-z0-9._:-]{1,256}$/u;

export const CUSTOM_CAPACITY_SCOPE = "isolated-custom-runtime-capacity" as const;

export type CustomCapacityResources = {
	requests: { cpu: string; memory: string };
	limits: { cpu: string; memory: string };
};

export type CustomCapacityJob = {
	schemaVersion: 1;
	scope: typeof CUSTOM_CAPACITY_SCOPE;
	sourceCommit: string;
	imageReference: string;
	imageDigest: string;
	platform: "linux/amd64" | "linux/arm64";
	resourceProfileRef: string;
	resources: CustomCapacityResources;
	kubeconfig: string;
	namespace: string;
	outputDirectory: string;
	principal: { kind: "application"; id: string };
	grantIssuer: string;
	workerId: string;
	grantKeyId: string;
	grantPublicKey: string;
	operatorApprovalRef: string;
	modelOptionId: string;
	reasoningLevel: string;
	runtimeConfigVersion: string;
	expectedReply?: string;
	grantPrivateKeyFile?: string;
	runtimeServiceTokenFile?: string;
	outputFile?: string;
	imagePullSecret?: string;
	podReadyTimeoutSeconds?: number;
};

const exact = (value: unknown, allowed: readonly string[], label: string) => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${label}_SHAPE_INVALID`);
	if (Object.keys(value).some((key) => !allowed.includes(key)))
		throw new Error(`${label}_UNBOUNDED`);
	return value as Record<string, unknown>;
};

const resources = (value: unknown): CustomCapacityResources => {
	const record = exact(value, ["requests", "limits"], "RESOURCES");
	const read = (key: string) => {
		const item = exact(record[key], ["cpu", "memory"], `RESOURCES_${key}`);
		if (typeof item.cpu !== "string" || typeof item.memory !== "string" || !item.cpu || !item.memory)
			throw new Error("RESOURCES_INVALID");
		return { cpu: item.cpu, memory: item.memory };
	};
	return { requests: read("requests"), limits: read("limits") };
};

export function validateCustomCapacityJob(input: unknown): CustomCapacityJob {
	const value = exact(input, [
		"schemaVersion", "scope", "sourceCommit", "imageReference", "imageDigest", "platform",
		"resourceProfileRef", "resources", "kubeconfig", "namespace", "outputDirectory", "principal",
		"grantIssuer", "workerId", "grantKeyId", "grantPublicKey", "operatorApprovalRef", "modelOptionId",
		"reasoningLevel", "runtimeConfigVersion", "expectedReply", "grantPrivateKeyFile", "runtimeServiceTokenFile", "outputFile", "imagePullSecret", "podReadyTimeoutSeconds",
	], "CUSTOM_CAPACITY_JOB");
	for (const key of ["sourceCommit", "imageDigest", "imageReference", "resourceProfileRef", "kubeconfig", "namespace", "outputDirectory", "grantIssuer", "workerId", "grantKeyId", "grantPublicKey", "operatorApprovalRef", "modelOptionId", "reasoningLevel", "runtimeConfigVersion"]) {
		if (typeof value[key] !== "string" || !value[key]) throw new Error(`CUSTOM_CAPACITY_${key.toUpperCase()}_INVALID`);
	}
	if (value.schemaVersion !== 1 || value.scope !== CUSTOM_CAPACITY_SCOPE || !sourcePattern.test(value.sourceCommit as string) || !digestPattern.test(value.imageDigest as string) || !(value.imageReference as string).endsWith(`@${value.imageDigest}`) || !["linux/amd64", "linux/arm64"].includes(value.platform as string)) throw new Error("CUSTOM_CAPACITY_JOB_INVALID");
	const principal = exact(value.principal, ["kind", "id"], "CUSTOM_CAPACITY_PRINCIPAL");
	if (principal.kind !== "application" || typeof principal.id !== "string" || !idPattern.test(principal.id)) throw new Error("CUSTOM_CAPACITY_PRINCIPAL_INVALID");
	if (value.imagePullSecret !== undefined && (typeof value.imagePullSecret !== "string" || !idPattern.test(value.imagePullSecret))) throw new Error("CUSTOM_CAPACITY_PULL_SECRET_INVALID");
	if (value.podReadyTimeoutSeconds !== undefined && (!Number.isSafeInteger(value.podReadyTimeoutSeconds) || value.podReadyTimeoutSeconds < 60 || value.podReadyTimeoutSeconds > 1800)) throw new Error("CUSTOM_CAPACITY_TIMEOUT_INVALID");
	return { ...value, principal: { kind: "application", id: principal.id }, resources: resources(value.resources) } as CustomCapacityJob;
}

export function buildCustomMeasurementPod(jobInput: unknown, podName: string, owner: string) {
	const job = validateCustomCapacityJob(jobInput);
	if (!idPattern.test(podName) || !idPattern.test(owner)) throw new Error("CUSTOM_CAPACITY_POD_ID_INVALID");
	return {
		apiVersion: "v1", kind: "Pod",
		metadata: { name: podName, namespace: job.namespace, labels: {
			"agent-infra.validation-owner": owner,
			"agent-infra.validation-scope": CUSTOM_CAPACITY_SCOPE,
			"agent-infra.validation-source": job.sourceCommit,
		} },
		spec: {
			automountServiceAccountToken: false,
			restartPolicy: "Never",
			imagePullSecrets: job.imagePullSecret ? [{ name: job.imagePullSecret }] : [],
			securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: "RuntimeDefault" } },
			containers: [{
				name: "runtime", image: job.imageReference,
				resources: job.resources,
				securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
				env: [
					{ name: "AGENT_INFRA_RUNTIME_DRIVER", value: "acp" },
					{ name: "AGENT_INFRA_RUNTIME_AGENT_ID", value: `custom-capacity-${owner.slice(0, 12)}` },
					{ name: "AGENT_INFRA_RUNTIME_WORKER_ID", value: job.workerId },
					{ name: "AGENT_INFRA_RUNTIME_GRANT_KEY_ID", value: job.grantKeyId },
					{ name: "AGENT_INFRA_RUNTIME_GRANT_ISSUER", value: job.grantIssuer },
					{ name: "AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY", value: job.grantPublicKey },
					{ name: "AGENT_INFRA_RUNTIME_SERVICE_TOKEN", valueFrom: { secretKeyRef: { name: `${podName}-auth`, key: "service-token" } } },
					{ name: "AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_ENABLED", value: "worker-v1" },
					{ name: "AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_SCOPE", value: podName },
					{ name: "AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_ATTESTATION", valueFrom: { secretKeyRef: { name: `${podName}-auth`, key: "attestation" } } },
				],
				ports: [{ containerPort: 3003 }],
				readinessProbe: { httpGet: { path: "/healthz", port: 3003 }, initialDelaySeconds: 2, periodSeconds: 3 },
			}],
			volumes: [{ name: "data", emptyDir: {} }, { name: "tmp", emptyDir: {} }],
		},
	};
}

export function buildCustomV3TurnRequest(input: { job: unknown; agentId: string; conversationId: string; executionId: string; turnId: string; operationId: string; traceId: string; grantToken: string }) {
	const job = validateCustomCapacityJob(input.job);
	for (const key of ["agentId", "conversationId", "executionId", "turnId", "operationId", "traceId", "grantToken"]) if (typeof input[key as keyof typeof input] !== "string" || !(input[key as keyof typeof input] as string)) throw new Error("CUSTOM_CAPACITY_REQUEST_INVALID");
	const request = {
		schemaVersion: 3 as const, requestId: input.turnId, traceId: input.traceId,
		principal: job.principal, channelId: "isolated-custom-capacity", agentId: input.agentId,
		conversationId: input.conversationId, executionId: input.executionId, turnId: input.turnId,
		sessionGeneration: 1, hostSessionRef: null,
		operation: { kind: "execution" as const, id: input.operationId, deliveryFence: 1, executionDeliveryFence: 1 },
		input: { text: "Reply exactly READY. Do not use tools.", attachments: [] },
		grant: { schemaVersion: 2 as const, format: "runtime-execution-jws" as const, token: input.grantToken },
	};
	// Deliberately no executionSource/keyBinding/Relay-key fields: custom V3/Grant V2 does not consume standard V4.
	return request;
}

export function createCustomCapacityReceipt(input: { job: unknown; observed: { imageDigest: string; sourceCommit: string; resources: CustomCapacityResources; terminalStatus: "completed" | "failed" | "unknown"; replyMatched: boolean; submittedAt: number; completedAt: number; modelFacts: { phase: string; operationHash: string }[]; podUid: string } }) {
	const job = validateCustomCapacityJob(input.job);
	const observed = input.observed;
	if (observed.imageDigest !== job.imageDigest || observed.sourceCommit !== job.sourceCommit || observed.terminalStatus !== "completed" || observed.replyMatched !== true || observed.completedAt < observed.submittedAt || observed.modelFacts.length < 1 || observed.modelFacts.some((fact) => fact.phase !== "completed") || !observed.podUid) throw new Error("CUSTOM_CAPACITY_MEASUREMENT_INVALID");
	if (JSON.stringify(observed.resources) !== JSON.stringify(job.resources)) throw new Error("CUSTOM_CAPACITY_RESOURCES_DRIFT");
	return {
		schemaVersion: 1, scope: CUSTOM_CAPACITY_SCOPE, sourceCommit: job.sourceCommit,
		imageDigest: job.imageDigest, observedResources: observed.resources,
		maximumConcurrentExecutions: 1, terminalStatus: observed.terminalStatus,
		replyMatched: observed.replyMatched, modelOperationCount: observed.modelFacts.length,
		submittedAt: observed.submittedAt, completedAt: observed.completedAt,
		podUidSha256: createHash("sha256").update(observed.podUid).digest("hex"),
		modelFacts: observed.modelFacts,
		platformBusinessVerified: false,
	};
}

export function capacityEvidenceHash(receipt: unknown) {
	return createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
}

async function privateFile(path: string, label: string) {
	if (!isAbsolute(path)) throw new Error(`${label}_PATH_INVALID`);
	const stat = await lstat(path);
	if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error(`${label}_FILE_INVALID`);
	return readFile(path);
}

const b64 = (value: string | Uint8Array) => Buffer.from(value).toString("base64url");
function signGrant(request: ReturnType<typeof buildCustomV3TurnRequest> & { hostSessionRef?: string; consumer?: "platform_worker_persistence"; afterCursor?: string | null }, job: CustomCapacityJob, privateKey: ReturnType<typeof createPrivateKey>, command: "turn.submit" | "events.persist" = "turn.submit") {
	const now = Date.now();
	const claims = {
		schemaVersion: 2, issuer: job.grantIssuer, audience: "runtime_host", issuedAt: now, expiresAt: now + 30_000,
		grantId: randomUUID(), workerId: job.workerId, principal: request.principal, agentId: request.agentId,
		channelId: request.channelId, conversationId: request.conversationId, executionId: request.executionId,
		turnId: request.turnId, sessionGeneration: 1, traceId: request.traceId, hostSessionRef: null,
		operation: request.operation, purpose: "business", authorizationRecordId: `isolated-capacity-${randomUUID()}`,
		allowedCommands: [command], attachments: [],
		...(command === "events.persist" ? { eventAccess: { command, consumer: request.consumer, afterCursor: request.afterCursor ?? null } } : {}),
		requestDigest: createHash("sha256").update(canonicalRuntimeRequestSigningPayload({ ...request, grant: undefined })).digest("hex"),
	};
	const protectedPart = b64(JSON.stringify({ alg: "EdDSA", kid: job.grantKeyId, typ: "runtime-execution+jws" }));
	const claimsPart = b64(JSON.stringify(claims));
	const signingInput = `${protectedPart}.${claimsPart}`;
	return { schemaVersion: 2 as const, format: "runtime-execution-jws" as const, token: `${signingInput}.${sign(null, Buffer.from(signingInput, "ascii"), privateKey).toString("base64url")}` };
}

const kubectl = (job: CustomCapacityJob, args: string[], input?: string) => execFileSync("kubectl", ["--kubeconfig", job.kubeconfig, "--request-timeout=45s", "-n", job.namespace, ...args], { input, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });

/** Execute the real bounded producer. It is intentionally CLI-only; tests use the transport seam above. */
export async function executeCustomCapacityJob(jobPath: string) {
	const job = validateCustomCapacityJob(JSON.parse((await privateFile(jobPath, "JOB")).toString("utf8")));
	if (!job.grantPrivateKeyFile || !job.runtimeServiceTokenFile || !job.outputFile) throw new Error("CUSTOM_CAPACITY_PRIVATE_INPUTS_REQUIRED");
	const owner = randomUUID();
	const podName = `ack-custom-capacity-${owner.slice(0, 8)}`;
	const serviceToken = (await privateFile(job.runtimeServiceTokenFile, "SERVICE_TOKEN")).toString().trim();
	const privateKey = createPrivateKey(await privateFile(job.grantPrivateKeyFile, "GRANT_KEY"));
	const attestation = createHash("sha256").update(`${podName}\0${serviceToken}`).digest("base64url");
	const secretName = `${podName}-auth`;
	const attestationFile = join(job.outputDirectory ?? "/tmp", `.attestation-${owner}`);
	let podUid: string | undefined;
	let forward: ReturnType<typeof spawn> | undefined;
	try {
		await mkdir(dirname(attestationFile), { recursive: true, mode: 0o700 });
		await writeFile(attestationFile, attestation, { mode: 0o600 });
		const secret = kubectl(job, ["create", "secret", "generic", secretName, `--from-file=service-token=${job.runtimeServiceTokenFile}`, `--from-file=attestation=${attestationFile}`, "--dry-run=client", "-o", "json"]);
		kubectl(job, ["apply", "-f", "-"], secret);
		const pod = buildCustomMeasurementPod(job, podName, owner);
		kubectl(job, ["create", "-f", "-"], JSON.stringify(pod));
		kubectl(job, ["wait", "--for=condition=Ready", `pod/${podName}`, `--timeout=${job.podReadyTimeoutSeconds ?? 900}s`]);
		const observedPod = JSON.parse(kubectl(job, ["get", "pod", podName, "-o", "json"]));
		podUid = observedPod.metadata?.uid;
		if (!podUid || observedPod.spec?.containers?.[0]?.image !== job.imageReference) throw new Error("CUSTOM_CAPACITY_POD_TUPLE_MISMATCH");
		const port = 35000 + Math.floor(Math.random() * 1000);
		forward = spawn("kubectl", ["--kubeconfig", job.kubeconfig, "-n", job.namespace, "port-forward", `pod/${podName}`, `${port}:3003`], { stdio: "ignore" });
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) { try { if ((await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_000) })).status === 200) break; } catch {} await new Promise((resolve) => setTimeout(resolve, 250)); }
		const request = buildCustomV3TurnRequest({ job, agentId: `custom-capacity-${owner.slice(0, 12)}`, conversationId: `capacity-conversation-${owner}`, executionId: `capacity-execution-${owner}`, turnId: `capacity-turn-${owner}`, operationId: `capacity-operation-${owner}`, traceId: `capacity-trace-${owner}`, grantToken: "unsigned.unsigned.unsigned" });
		const grant = signGrant(request, job, privateKey);
		const serviceHeaders = { authorization: `Bearer ${serviceToken}`, "content-type": "application/json", accept: "application/json" };
		const negative = await fetch(`http://127.0.0.1:${port}/internal/runtime/v3/turns`, { method: "POST", headers: { ...serviceHeaders, authorization: "Bearer wrong-token" }, body: JSON.stringify({ ...request, grant }) });
		if (![401, 403].includes(negative.status)) throw new Error("CUSTOM_CAPACITY_WRONG_TOKEN_ACCEPTED");
		const crossBinding = await fetch(`http://127.0.0.1:${port}/internal/runtime/v3/turns`, { method: "POST", headers: serviceHeaders, body: JSON.stringify({ ...request, agentId: `tampered-${owner}`, grant }) });
		if (crossBinding.status !== 403) throw new Error("CUSTOM_CAPACITY_CROSS_BINDING_ACCEPTED");
		const accepted = await fetch(`http://127.0.0.1:${port}/internal/runtime/v3/turns`, { method: "POST", headers: serviceHeaders, body: JSON.stringify({ ...request, grant }) });
		if (!accepted.ok) throw new Error("CUSTOM_CAPACITY_SUBMIT_FAILED");
		const output = JSON.parse(await accepted.text());
		if (output.result?.outcome !== "accepted") throw new Error("CUSTOM_CAPACITY_SUBMIT_NOT_ACCEPTED");
		const eventRequest = { ...request, hostSessionRef: output.hostSessionRef, consumer: "platform_worker_persistence" as const, afterCursor: null };
		const eventGrant = signGrant(eventRequest, job, privateKey, "events.persist");
		const eventsResponse = await fetch(`http://127.0.0.1:${port}/internal/runtime/v3/events/read`, { method: "POST", headers: serviceHeaders, body: JSON.stringify({ ...eventRequest, grant: eventGrant }) });
		if (!eventsResponse.ok) throw new Error("CUSTOM_CAPACITY_EVENTS_READ_FAILED");
		const text = await eventsResponse.text();
		const events = [...text.matchAll(/^data:\s*(\{.*\})$/gmu)].map((match) => JSON.parse(match[1]));
		let reply = "";
		const modelFacts: { phase: string; operationHash: string }[] = [];
		let completed = false;
		for (const event of events) {
			const payload = event.payload ?? event;
			if (event.type === "text" || event.type === "message.delta") reply += payload.delta ?? payload.text ?? "";
			if (event.type === "operation" && payload.kind === "model") modelFacts.push({ phase: payload.phase, operationHash: createHash("sha256").update(JSON.stringify(payload.operationRef ?? payload)).digest("hex") });
			if (event.type === "completed" || event.type === "status" && payload.status === "completed") completed = true;
		}
		const observed = { imageDigest: job.imageDigest, sourceCommit: job.sourceCommit, resources: job.resources, terminalStatus: completed ? "completed" as const : "unknown" as const, replyMatched: reply.trim() === (job.expectedReply ?? "READY"), submittedAt: Date.now() - 1000, completedAt: Date.now(), modelFacts, podUid: podUid! };
		const receipt = createCustomCapacityReceipt({ job, observed });
		if (!job.outputFile) throw new Error("CUSTOM_CAPACITY_OUTPUT_REQUIRED");
		await mkdir(dirname(job.outputFile), { recursive: true, mode: 0o700 });
		const temporary = `${job.outputFile}.${owner}.tmp`;
		await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		await rename(temporary, job.outputFile);
		return { status: "passed" as const, receipt, cleanup: { deleted: true, uid: podUid! } };
	} catch (error) {
		if (job.outputFile) {
			const failure = { schemaVersion: 1, scope: CUSTOM_CAPACITY_SCOPE, sourceCommit: job.sourceCommit, imageDigest: job.imageDigest, status: "failed", businessVerified: false, failure: error instanceof Error ? error.message : "CUSTOM_CAPACITY_FAILED" };
			const temporary = `${job.outputFile}.${owner}.failed.tmp`;
			await mkdir(dirname(job.outputFile), { recursive: true, mode: 0o700 }).catch(() => {});
			await writeFile(temporary, `${JSON.stringify(failure, null, 2)}\n`, { mode: 0o600, flag: "wx" }).then(() => rename(temporary, job.outputFile)).catch(() => {});
		}
		throw error;
	} finally {
		forward?.kill("SIGTERM");
		try { kubectl(job, ["delete", "pod", podName, "--ignore-not-found", "--wait=false"]); } catch {}
		try { kubectl(job, ["delete", "secret", secretName, "--ignore-not-found"]); } catch {}
		await unlink(attestationFile).catch(() => {});
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try { await executeCustomCapacityJob(process.argv[2]); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "CUSTOM_CAPACITY_FAILED"}\n`); process.exitCode = 1; }
}

export type CustomCapacityTransport = {
	createPod: (pod: ReturnType<typeof buildCustomMeasurementPod>) => Promise<{ uid: string; imageDigest: string; sourceCommit: string; resources: CustomCapacityResources }>;
	waitReady: () => Promise<void>;
	negativeChecks: () => Promise<{ wrongTokenRejected: boolean; crossBindingRejected: boolean }>;
	submitV3: (request: ReturnType<typeof buildCustomV3TurnRequest>) => Promise<{ executionId: string; conversationId: string }>;
	readTerminal: (ids: { executionId: string; conversationId: string }) => Promise<{ status: "completed" | "failed" | "unknown"; replyMatched: boolean; submittedAt: number; completedAt: number; modelFacts: { phase: string; operationHash: string }[] }>;
	deletePod: (uid: string) => Promise<{ deleted: boolean; uid: string }>;
};

/**
 * Bounded custom capacity producer seam. The transport is deliberately injected:
 * production wiring owns kubectl/port-forward/Secret lifecycle, while tests can
 * prove the V3/GrantV2 and cleanup contract without importing private modules.
 */
export async function runCustomCapacityMeasurement(input: {
	job: unknown;
	podName: string;
	owner: string;
	request: Parameters<typeof buildCustomV3TurnRequest>[0];
	transport: CustomCapacityTransport;
}) {
	const job = validateCustomCapacityJob(input.job);
	const pod = buildCustomMeasurementPod(job, input.podName, input.owner);
	let podRef: { uid: string; imageDigest: string; sourceCommit: string; resources: CustomCapacityResources } | undefined;
	try {
		podRef = await input.transport.createPod(pod);
		if (podRef.imageDigest !== job.imageDigest || podRef.sourceCommit !== job.sourceCommit || JSON.stringify(podRef.resources) !== JSON.stringify(job.resources)) throw new Error("CUSTOM_CAPACITY_POD_TUPLE_MISMATCH");
		await input.transport.waitReady();
		const negative = await input.transport.negativeChecks();
		if (!negative.wrongTokenRejected || !negative.crossBindingRejected) throw new Error("CUSTOM_CAPACITY_NEGATIVE_CHECK_FAILED");
		const ids = await input.transport.submitV3(input.request);
		const observed = await input.transport.readTerminal(ids);
		const receipt = createCustomCapacityReceipt({ job, observed: { ...observed, terminalStatus: observed.status, imageDigest: podRef.imageDigest, sourceCommit: podRef.sourceCommit, resources: podRef.resources, podUid: podRef.uid } });
		return { status: "passed" as const, receipt, cleanup: await input.transport.deletePod(podRef.uid) };
	} catch (error) {
		const cleanup = podRef ? await input.transport.deletePod(podRef.uid).catch(() => ({ deleted: false, uid: podRef!.uid })) : { deleted: false, uid: null };
		return { status: "failed" as const, failure: error instanceof Error ? error.message : "CUSTOM_CAPACITY_MEASUREMENT_FAILED", cleanup };
	}
}
