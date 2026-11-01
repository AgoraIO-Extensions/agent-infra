import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parseAllDocuments } from "yaml";
import { prepareBootstrapInputs } from "./bootstrap-inputs.ts";
import { privateBytes, privateJson } from "./private-input.ts";
import { validateTemplateValidationExpectations } from "./template-validation.mjs";
import { validateCapacityBindings } from "./workload-capacity.ts";
import { ApiRolloutObservationError, apiReplicaTarget, apiRolloutTools, observeApiRollout } from "./api-rollout-observation.ts";
import { prepareReserveInput, readReserveApi, readReserveWorker } from "./session-reserve-inputs.ts";
import { sessionSandboxReserveDigestV1 } from "../../packages/platform-core/src/session-sandbox-reserves.ts";

type ObjectRecord = Record<string, any>;
type Kubectl = (args: string[], input?: string) => string;
type Files = {
	bootstrap: string;
	templates: string;
	capacity: string;
	requests: string;
	login?: string;
	reserves?: string;
};
type PublicationProgress = {
	phase: "preflight" | "secret-write" | "local-promotion" | "rollout" | "login" | "verification";
	mutationStatus: "not-applied" | "attempted" | "applied";
};
const failureCodes = new Set([
	"RUNTIME_INPUTS_INVALID", "RUNTIME_INPUT_LOGIN_REQUIRED", "RUNTIME_INPUT_CLUSTER_DRIFT",
	"RUNTIME_INPUT_RESERVE_CONSUMER_MISMATCH",
	"RUNTIME_INPUT_NAMESPACE_OWNER_INVALID", "RUNTIME_INPUT_NAMESPACE_DRIFT",
	"RUNTIME_INPUT_SECRET_MISSING", "RUNTIME_INPUT_SECRET_UNAVAILABLE", "RUNTIME_INPUT_SECRET_OWNER_INVALID",
	"RUNTIME_INPUT_SECRET_DRIFT", "RUNTIME_INPUT_SECRET_VERSION_DRIFT", "RUNTIME_INPUT_SECRET_READBACK_FAILED",
	"RUNTIME_INPUT_SECRET_CHANGED_DURING_ROLLOUT", "RUNTIME_INPUT_CONSUMER_INVALID", "RUNTIME_INPUT_CONSUMER_MISSING",
	"RUNTIME_INPUT_CONFIGURATION_MOUNT_INVALID", "RUNTIME_INPUT_CONSUMER_DRIFT",
	"RUNTIME_INPUT_REPLICA_COUNT_INVALID", "RUNTIME_INPUT_REPLICA_DRIFT",
	"RUNTIME_INPUT_CONSUMER_VERSION_DRIFT", "RUNTIME_INPUT_CONSUMER_ROLLOUT_FAILED", "RUNTIME_INPUT_LOCAL_DRIFT",
	"RUNTIME_INPUT_TEMPLATE_VALIDATION_FAILED", "RUNTIME_INPUT_TEMPLATE_TARGET_MISSING", "RUNTIME_INPUT_TEMPLATE_REQUEST_MISSING",
	"RUNTIME_INPUT_CAPACITY_TUPLE_INVALID", "RUNTIME_INPUT_CAPACITY_AMBIGUOUS", "RUNTIME_INPUT_CAPACITY_TARGET_INVALID",
	"RUNTIME_INPUT_IDENTITY_TARGET_INVALID", "RUNTIME_INPUT_IDENTITY_TARGET_MISSING",
	"RUNTIME_INPUT_FILE_BINDING_CONFLICT", "RUNTIME_INPUT_FILE_INSIDE_WORKTREE",
	"LOGIN_AUTHENTICATION_FAILED", "LOGIN_SESSION_READ_FAILED", "LOGIN_SESSION_INVALID", "LOGIN_COOKIE_INVALID",
	"LOGIN_SESSION_CHANGED", "LOGIN_SUBJECTS_NOT_DISTINCT", "LOGIN_CANDIDATE_INVALID", "LOGIN_CANDIDATE_CHANGED",
	"LOGIN_CANDIDATE_SESSION_MISMATCH", "LOGIN_OUTPUT_CHANGED", "LOGIN_OUTPUT_PROMOTION_INCOMPLETE", "LOGIN_ORIGIN_MISMATCH",
]);
class RuntimeInputPublicationError extends Error {
	readonly receipt: PublicationProgress & {
		schemaVersion: number; kind: string; status: string; failureCode: string;
		recoveryRequired: boolean; loginVerified: boolean; businessVerified: boolean;
	};
	constructor(error: unknown, progress: PublicationProgress) {
		const code = error instanceof Error ? error.message.split("\n", 1)[0] ?? "" : "";
		const failureCode = failureCodes.has(code) ? code : "RUNTIME_INPUTS_INVALID";
		super(failureCode);
		this.receipt = { schemaVersion: 1, kind: "ack-runtime-inputs", status: "failed", failureCode,
			...progress, recoveryRequired: progress.mutationStatus !== "not-applied", loginVerified: false, businessVerified: false };
	}
}
const ownerLabel = "agent-infra.agora.io/bootstrap-id";
const revisionAnnotation = "agent-infra.agora.io/runtime-inputs-hash";
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const jsonBytes = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function configurationSecret(deployment: ObjectRecord, component: "api" | "worker") {
	const spec = deployment.spec?.template?.spec;
	const container = spec?.containers?.find((c: any) => c.name === `platform-${component}`);
	assert(container, "RUNTIME_INPUT_CONSUMER_INVALID");
	const variable = component === "api" ? "PLATFORM_API_CONFIGURATION_MODULE" : "PLATFORM_WORKER_DEPLOYMENT_MODULE";
	const url = container.env?.find((e: any) => e.name === variable)?.value;
	assert(typeof url === "string" && url.startsWith("file:///"));
	const path = fileURLToPath(component === "api" ? url : new URL("./configuration.mjs", url));
	const mounts = container.volumeMounts?.filter((m: any) => m.readOnly &&
		(m.mountPath === path || (!m.subPath && path.startsWith(`${m.mountPath}/`)))) ?? [];
	assert.equal(mounts.length, 1, "RUNTIME_INPUT_CONFIGURATION_MOUNT_INVALID");
	const volume = spec.volumes?.find((v: any) => v.name === mounts[0].name);
	assert(volume?.secret?.secretName && !volume.secret.items, "RUNTIME_INPUT_CONFIGURATION_MOUNT_INVALID");
	return volume.secret.secretName as string;
}

async function prepare(files: Files, rendered: string, sourceSha: string, kubectl: Kubectl) {
	const bootstrap = await privateJson(files.bootstrap);
	const templates = await privateJson(files.templates);
	const capacity = await privateJson(files.capacity);
	const requests = await privateJson(files.requests);
	assert(/^[a-f0-9]{40}$/u.test(sourceSha) && templates.sourceSha === sourceSha && capacity.sourceSha === sourceSha);
	assert((await validateTemplateValidationExpectations(templates)).pass, "RUNTIME_INPUT_TEMPLATE_VALIDATION_FAILED");
	const objects = await prepareBootstrapInputs(bootstrap, rendered);
	const documents = parseAllDocuments(rendered).map((d) => {
		assert.equal(d.errors.length, 0);
		return d.toJSON();
	}).filter(Boolean);
	const consumers = (["api", "worker"] as const).map((component) => {
		const name = `agent-infra-${component}`;
		const deployment = documents.find((d) => d.kind === "Deployment" && d.metadata?.name === name);
		assert(deployment, "RUNTIME_INPUT_CONSUMER_MISSING");
		const replicas = deployment.spec?.replicas ?? 1;
		assert(Number.isSafeInteger(replicas) && replicas > 0 && replicas <= 10 && (component !== "worker" || replicas === 1), "RUNTIME_INPUT_REPLICA_COUNT_INVALID");
		return { name, component, replicas, secretName: configurationSecret(deployment, component) };
	});
	const secrets = [...new Set(consumers.map((c) => c.secretName))].map((name) => {
		const object = objects.find((o) => o.kind === "Secret" && o.metadata.name === name);
		const binding = bootstrap.objects.find((o: any) => o.kind === "Secret" && o.name === name);
		assert(object?.type === "Opaque" && binding);
		return { before: object, desired: structuredClone(object), files: binding.files };
	});
	const writes = new Map<string, { before: Buffer; after: Buffer }>();
	const stageFile = async (file: string, after: Buffer) => {
		const before = await privateBytes(file);
		if (writes.has(file)) assert.deepEqual(writes.get(file)!.after, after, "RUNTIME_INPUT_FILE_BINDING_CONFLICT");
		else {
			let insideGit = false;
			try { insideGit = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dirname(file), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() === "true"; } catch {}
			assert(!insideGit, "RUNTIME_INPUT_FILE_INSIDE_WORKTREE");
			writes.set(file, { before, after });
		}
	};
	let loginCandidate: Buffer | undefined;
	if (files.login) {
		const { verifiedLoginCandidate } = await import("./bootstrap-login.ts");
		const candidate = await verifiedLoginCandidate(files.login, sourceSha, requests.origin);
		loginCandidate = candidate.bytes;
		const api = consumers.find((c) => c.component === "api")!;
		assert(candidate.secretRef.name === api.secretName && candidate.secretRef.key === "deployment-identities.json", "RUNTIME_INPUT_IDENTITY_TARGET_INVALID");
		const secret = secrets.find((s) => s.desired.metadata.name === api.secretName)!;
		const target = secret.files[candidate.secretRef.key];
		assert(typeof target === "string", "RUNTIME_INPUT_IDENTITY_TARGET_MISSING");
		await stageFile(target, candidate.bytes);
		secret.desired.data[candidate.secretRef.key] = candidate.bytes.toString("base64");
	}
	const profilesDocument = await privateJson(capacity.profilesFile);
	assert(profilesDocument.schemaVersion === 1 && Array.isArray(profilesDocument.profiles));
	let profiles = profilesDocument.profiles;
	const resources = {
		requests: { cpu: capacity.resources?.requests?.cpu, memory: capacity.resources?.requests?.memory },
		limits: { cpu: capacity.resources?.limits?.cpu, memory: capacity.resources?.limits?.memory },
	};
	const resourceConfigurationHash = hash(JSON.stringify({ resourceProfileRef: capacity.resourceProfileRef, ...resources }));
	assert(Array.isArray(capacity.evidence) && capacity.evidence.length <= 64);
	const evidenceFiles = new Map<string, string>();
	for (const entry of capacity.evidence) {
		assert(!evidenceFiles.has(entry.imageDigest));
		evidenceFiles.set(entry.imageDigest, entry.file);
	}
	for (const expected of templates.templates) {
		const candidate = await privateBytes(expected.validationFile);
		const key = `template-validation-${expected.templateId}.json`;
		for (const secret of secrets) {
			assert(typeof secret.files[key] === "string", "RUNTIME_INPUT_TEMPLATE_TARGET_MISSING");
			await stageFile(secret.files[key], candidate);
			secret.desired.data[key] = candidate.toString("base64");
		}
		const file = join(dirname(expected.validationFile), "runtime-capacity.receipt.json");
		const measuredBytes = await privateBytes(file);
		const measured = JSON.parse(measuredBytes.toString("utf8"));
		const preflight = await privateJson(expected.preflightFile);
		assert(measured.scope === "ack-runtime-capacity" && measured.sourceCommit === sourceSha &&
			measured.imageDigest === expected.imageDigest && measured.completedAt === preflight.validatedAt &&
			measured.modelOperationCount === preflight.modelOperationCount, "RUNTIME_INPUT_CAPACITY_TUPLE_INVALID");
		const matches = (p: any) => p.imageDigest === expected.imageDigest && p.resourceProfileRef === capacity.resourceProfileRef && p.resourceConfigurationHash === resourceConfigurationHash;
		assert(profiles.filter(matches).length <= 1, "RUNTIME_INPUT_CAPACITY_AMBIGUOUS");
		profiles = [...profiles.filter((p: any) => !matches(p)), {
			schemaVersion: 1, imageDigest: expected.imageDigest, resourceProfileRef: capacity.resourceProfileRef,
			resourceConfigurationHash, maximumConcurrentExecutions: 1, conformanceEvidenceHash: hash(measuredBytes),
		}];
		evidenceFiles.set(expected.imageDigest, file);
	}
	assert(evidenceFiles.size <= 64 && profiles.length <= 64);
	const evidence = new Map<string, Uint8Array>();
	for (const [digest, file] of evidenceFiles) evidence.set(digest, await privateBytes(file));
	assert(requests.schemaVersion === 1 && Array.isArray(requests.requests));
	const bodies = await Promise.all(requests.requests.map((r: any) => privateJson(r.bodyFile)));
	assert(templates.templates.every((t: any) => bodies.some((b: any) => b.source?.kind === "standard" && b.source.templateId === t.templateId)), "RUNTIME_INPUT_TEMPLATE_REQUEST_MISSING");
	validateCapacityBindings(bodies, templates.templates, capacity, profiles, evidence);
	const worker = consumers.find((c) => c.component === "worker")!;
	assert(capacity.workerSecretRef?.name === worker.secretName);
	const workerSecret = secrets.find((s) => s.desired.metadata.name === worker.secretName)!;
	assert(workerSecret.files[capacity.workerSecretRef.key] === capacity.profilesFile, "RUNTIME_INPUT_CAPACITY_TARGET_INVALID");
	const profileBytes = jsonBytes({ ...profilesDocument, profiles });
	await stageFile(capacity.profilesFile, profileBytes);
	workerSecret.desired.data[capacity.workerSecretRef.key] = profileBytes.toString("base64");
	await stageFile(files.capacity, jsonBytes({ ...capacity, evidence: [...evidenceFiles].map(([imageDigest, file]) => ({ imageDigest, file })) }));
	if (files.reserves) {
		await prepareReserveInput({
			ACK_BOOTSTRAP_INPUTS_FILE: files.bootstrap,
			ACK_SESSION_RESERVES_FILE: files.reserves,
			ACK_NAMESPACE: bootstrap.namespace,
			ACK_WORKLOAD_CAPACITY_FILE: files.capacity,
			ACK_TEMPLATE_VALIDATIONS_FILE: files.templates,
		}, sourceSha, {
			workerSecretName: worker.secretName,
			apiSecretName: consumers.find((c) => c.component === "api")!.secretName,
			requireAdoption: false,
			readWorker: (environment, input, name) => readReserveWorker({ ...environment, ACK_SOURCE_SHA: sourceSha }, input, name, kubectl, false),
		});
		const bytes = await privateBytes(files.reserves);
		const publishedBootstrap = structuredClone(bootstrap);
		let changedBindings = false;
		for (const consumer of consumers) {
			const secret = secrets.find((s) => s.desired.metadata.name === consumer.secretName)!;
			const target = secret.files["session-reserves.json"] ?? files.reserves;
			await stageFile(target, bytes);
			secret.desired.data["session-reserves.json"] = bytes.toString("base64");
			if (!secret.files["session-reserves.json"]) {
				publishedBootstrap.objects.find((object: any) => object.kind === "Secret" && object.name === consumer.secretName).files["session-reserves.json"] = target;
				changedBindings = true;
			}
		}
		if (changedBindings) await stageFile(files.bootstrap, jsonBytes(publishedBootstrap));
	}
	return { bootstrap, consumers, secrets, writes, loginCandidate, origin: requests.origin };
}

export async function publishRuntimeInputs(files: Files, rendered: string, sourceSha: string, kubectl: Kubectl, apply = false, timeout = "300s") {
	const progress: PublicationProgress = { phase: "preflight", mutationStatus: "not-applied" };
	try {
		assert(!apply || files.login, "RUNTIME_INPUT_LOGIN_REQUIRED");
		const result = await publishRuntimeInputsWithProgress(files, rendered, sourceSha, kubectl, apply, timeout, progress);
		return { ...result, mutationStatus: progress.mutationStatus };
	} catch (error) {
		throw new RuntimeInputPublicationError(error, progress);
	}
}

async function publishRuntimeInputsWithProgress(files: Files, rendered: string, sourceSha: string, kubectl: Kubectl, apply: boolean, timeout: string, progress: PublicationProgress) {
	const plan = await prepare(files, rendered, sourceSha, kubectl);
	const { namespace, clusterUid, installationId } = plan.bootstrap;
	const read = (kind: string, name: string, scoped = true) => JSON.parse(kubectl([
		...(scoped ? ["-n", namespace] : []), "get", kind, name, "-o", "json",
	]));
	assert(read("namespace", "kube-system", false).metadata?.uid === clusterUid, "RUNTIME_INPUT_CLUSTER_DRIFT");
	const ns = read("namespace", namespace, false);
	assert(ns.metadata?.uid && ns.metadata.labels?.[ownerLabel] === installationId, "RUNTIME_INPUT_NAMESPACE_OWNER_INVALID");
	const assertNamespace = () => {
		const current = read("namespace", namespace, false);
		assert(current.metadata?.uid === ns.metadata.uid && current.metadata.labels?.[ownerLabel] === installationId, "RUNTIME_INPUT_NAMESPACE_DRIFT");
	};
	const readSecret = (name: string) => {
		let raw: string;
		try {
			raw = kubectl(["-n", namespace, "get", "secret", name, "--ignore-not-found", "-o", "json"]);
		} catch {
			throw new Error("RUNTIME_INPUT_SECRET_UNAVAILABLE");
		}
		assert(raw?.trim(), "RUNTIME_INPUT_SECRET_MISSING");
		try { return JSON.parse(raw); }
		catch { throw new Error("RUNTIME_INPUT_SECRET_UNAVAILABLE"); }
	};
	const secrets = plan.secrets.map((entry) => {
		const current = readSecret(entry.desired.metadata.name);
		assert(current.kind === "Secret" && current.metadata?.name === entry.desired.metadata.name && current.metadata.namespace === namespace && current.metadata.uid && current.metadata.resourceVersion &&
			current.metadata.labels?.[ownerLabel] === installationId && !current.metadata.deletionTimestamp && current.type === "Opaque" && !current.immutable, "RUNTIME_INPUT_SECRET_OWNER_INVALID");
		assert(isDeepStrictEqual(current.data, entry.before.data) || isDeepStrictEqual(current.data, entry.desired.data), "RUNTIME_INPUT_SECRET_DRIFT");
		return { ...entry, current, verifiedVersion: current.metadata.resourceVersion, changed: !isDeepStrictEqual(current.data, entry.desired.data) };
	});
	const consumers = plan.consumers.map((entry) => {
		const current = read("deployment", entry.name);
		assert(current.kind === "Deployment" && current.metadata?.name === entry.name && current.metadata.uid && current.metadata.resourceVersion && current.metadata.namespace === namespace &&
			configurationSecret(current, entry.component) === entry.secretName, "RUNTIME_INPUT_CONSUMER_DRIFT");
		assert((current.spec?.replicas ?? 1) === entry.replicas, "RUNTIME_INPUT_REPLICA_DRIFT");
		const data = secrets.find((s) => s.desired.metadata.name === entry.secretName)!.desired.data;
		const revision = hash(JSON.stringify(Object.entries(data).sort(([a], [b]) => a.localeCompare(b))));
		return { ...entry, current, observed: current, revision, changed: current.spec.template.metadata?.annotations?.[revisionAnnotation] !== revision };
	});
	const assertPublishedSecrets = () => {
		assertNamespace();
		for (const secret of secrets) {
			const current = readSecret(secret.current.metadata.name);
			assert(current.metadata?.uid === secret.current.metadata.uid && current.metadata.resourceVersion === secret.verifiedVersion &&
				current.metadata.labels?.[ownerLabel] === installationId && !current.metadata.deletionTimestamp &&
				isDeepStrictEqual(current.data, secret.desired.data), "RUNTIME_INPUT_SECRET_CHANGED_DURING_ROLLOUT");
		}
	};
	if (apply) {
		for (const [file, bytes] of plan.writes) assert.deepEqual(await privateBytes(file), bytes.before, "RUNTIME_INPUT_LOCAL_DRIFT");
		progress.phase = "secret-write";
		for (const secret of secrets) {
			assertNamespace();
			const current = readSecret(secret.current.metadata.name);
			assert(current.metadata.uid === secret.current.metadata.uid && current.metadata.resourceVersion === secret.current.metadata.resourceVersion &&
				current.metadata.labels?.[ownerLabel] === installationId && !current.metadata.deletionTimestamp, "RUNTIME_INPUT_SECRET_VERSION_DRIFT");
			if (secret.changed) {
				progress.mutationStatus = "attempted";
				kubectl(["-n", namespace, "replace", "--field-manager=agent-infra-runtime-inputs", "-f", "-"],
					JSON.stringify({ ...current, data: secret.desired.data }));
			}
			const observed = readSecret(current.metadata.name);
			assert(observed.metadata.uid === current.metadata.uid && observed.metadata.labels?.[ownerLabel] === installationId && !observed.metadata.deletionTimestamp &&
				isDeepStrictEqual(observed.data, secret.desired.data), "RUNTIME_INPUT_SECRET_READBACK_FAILED");
			secret.verifiedVersion = observed.metadata.resourceVersion;
			if (secret.changed) progress.mutationStatus = "applied";
		}
		assertPublishedSecrets();
		progress.phase = "local-promotion";
		for (const [file, bytes] of plan.writes) {
			assert.deepEqual(await privateBytes(file), bytes.before, "RUNTIME_INPUT_LOCAL_DRIFT");
			if (bytes.before.equals(bytes.after)) continue;
			const temporary = `${file}.runtime-inputs-${randomUUID()}`;
			try {
				progress.mutationStatus = "attempted";
				await writeFile(temporary, bytes.after, { mode: 0o600, flag: "wx" });
				await rename(temporary, file);
				progress.mutationStatus = "applied";
			}
			finally { await unlink(temporary).catch(() => {}); }
		}
		progress.phase = "rollout";
		for (const consumer of consumers) {
			assertNamespace();
			const current = read("deployment", consumer.name);
			assert(current.metadata.uid === consumer.current.metadata.uid && current.metadata.resourceVersion === consumer.current.metadata.resourceVersion, "RUNTIME_INPUT_CONSUMER_VERSION_DRIFT");
			assert((current.spec?.replicas ?? 1) === consumer.replicas, "RUNTIME_INPUT_REPLICA_DRIFT");
			assertPublishedSecrets();
			if (consumer.changed) {
				progress.mutationStatus = "attempted";
				kubectl(["-n", namespace, "patch", "deployment", consumer.name, "--type=merge", "-p", JSON.stringify({
					metadata: { uid: current.metadata.uid, resourceVersion: current.metadata.resourceVersion },
					spec: { template: { metadata: { annotations: { [revisionAnnotation]: consumer.revision } } } },
				})]);
				progress.mutationStatus = "applied";
			}
			kubectl(["-n", namespace, "rollout", "status", `deployment/${consumer.name}`, `--timeout=${timeout}`]);
			const observed = read("deployment", consumer.name);
			assert(observed.metadata.uid === current.metadata.uid && observed.spec.template.metadata.annotations?.[revisionAnnotation] === consumer.revision &&
				(observed.spec?.replicas ?? 1) === consumer.replicas && observed.status?.observedGeneration === observed.metadata.generation &&
				observed.status.updatedReplicas === consumer.replicas && observed.status.availableReplicas === consumer.replicas && observed.status.readyReplicas === consumer.replicas,
				"RUNTIME_INPUT_CONSUMER_ROLLOUT_FAILED");
			consumer.observed = observed;
			assertPublishedSecrets();
		}
		progress.phase = "login";
		assert(files.login && plan.loginCandidate, "RUNTIME_INPUT_LOGIN_REQUIRED");
		const { verifyLoginAfterRollout } = await import("./bootstrap-login.ts");
		await verifyLoginAfterRollout(files.login, sourceSha, plan.origin, plan.loginCandidate);
		progress.phase = "verification";
		assertPublishedSecrets();
		for (const consumer of consumers) {
			const current = read("deployment", consumer.name);
			assert(current.metadata.uid === consumer.current.metadata.uid && (current.spec?.replicas ?? 1) === consumer.replicas && current.spec.template.metadata.annotations?.[revisionAnnotation] === consumer.revision, "RUNTIME_INPUT_REPLICA_DRIFT");
			assert(current.status?.observedGeneration === current.metadata.generation && current.status.updatedReplicas === consumer.replicas && current.status.availableReplicas === consumer.replicas && current.status.readyReplicas === consumer.replicas, "RUNTIME_INPUT_CONSUMER_ROLLOUT_FAILED");
			consumer.observed = current;
		}
	}
	return { schemaVersion: 1, kind: "ack-runtime-inputs", status: "passed", mode: apply ? "applied-and-read-back" : "read-only-plan", sourceSha,
		secretCount: secrets.length, changedSecretCount: secrets.filter((s) => s.changed).length,
		consumers: consumers.map((c) => ({ component: c.component, desiredReplicas: c.replicas, declaredReplicas: c.observed.spec?.replicas ?? 1, updatedReplicas: c.observed.status?.updatedReplicas ?? null, availableReplicas: c.observed.status?.availableReplicas ?? null, readyReplicas: c.observed.status?.readyReplicas ?? null })),
		rolloutCount: consumers.filter((c) => c.changed).length, templateCount: 4, loginVerified: apply, businessVerified: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	let operationStarted = false;
	let appliedResult: Awaited<ReturnType<typeof publishRuntimeInputs>> | undefined;
	try {
		const [mode, bootstrap, templates, capacity, requests, rendered] = process.argv.slice(2);
		const { ACK_SOURCE_SHA: source, ACK_KUBECONFIG: kubeconfig, ACK_NAMESPACE: namespace } = process.env;
		assert(["plan", "apply"].includes(mode) && source && kubeconfig && namespace);
		assert((await privateJson(bootstrap)).namespace === namespace);
		const run: Kubectl = (args, input) => execFileSync("kubectl", ["--kubeconfig", kubeconfig, ...args], {
			input, encoding: "utf8", timeout: args.includes("rollout") ? 310_000 : args.includes("exec") ? 60_000 : 30_000,
			maxBuffer: 16 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
		});
		const manifest = await readFile(rendered, "utf8");
		const publish = async () => {
			operationStarted = true;
			return appliedResult = await publishRuntimeInputs({ bootstrap, templates, capacity, requests, login: process.env.ACK_LOGIN_BOOTSTRAP_FILE || undefined, reserves: process.env.ACK_SESSION_RESERVES_FILE || undefined }, manifest, source, run, mode === "apply");
		};
		if (mode === "apply") {
			assert(process.env.ACK_LOGIN_BOOTSTRAP_FILE, "RUNTIME_INPUT_LOGIN_REQUIRED");
			await publishRuntimeInputs({ bootstrap, templates, capacity, requests, login: process.env.ACK_LOGIN_BOOTSTRAP_FILE, reserves: process.env.ACK_SESSION_RESERVES_FILE || undefined }, manifest, source, run, false);
		}
		const observed = mode === "apply" ? await observeApiRollout({ ...apiRolloutTools(kubeconfig, namespace, 600_000), sourceSha: source, desiredReplicas: apiReplicaTarget(manifest), timeoutMs: 600_000 }, publish) : null;
		const result = observed ? { ...observed.value, apiRollout: observed.receipt } : await publish();
		let reserveConsumersVerified = false;
		if (mode === "apply" && process.env.ACK_SESSION_RESERVES_FILE) {
			const input = await privateJson(bootstrap);
			const expected = await privateJson(process.env.ACK_SESSION_RESERVES_FILE);
			const documents = parseAllDocuments(manifest).map((doc) => doc.toJSON());
			for (const component of ["api", "worker"] as const) {
				const deployment = documents.find((doc) => doc?.kind === "Deployment" && doc.metadata?.name === `agent-infra-${component}`);
				const readConsumer = component === "api" ? readReserveApi : readReserveWorker;
				const actual = readConsumer({ ACK_SOURCE_SHA: source, ACK_NAMESPACE: namespace, ACK_KUBECONFIG: kubeconfig }, input, configurationSecret(deployment, component), run);
				assert(actual?.sourceSha === source && actual.configurationHash === sessionSandboxReserveDigestV1(expected) && actual.configuration?.revision === expected.revision && actual.configuration?.enabled === expected.enabled, "RUNTIME_INPUT_RESERVE_CONSUMER_MISMATCH");
			}
			reserveConsumersVerified = true;
		}
		process.stdout.write(`${JSON.stringify({ ...result, reserveConsumersVerified })}\n`);
	} catch (error) {
		const operationError = error instanceof ApiRolloutObservationError ? error.operationError : error;
		const failure = operationError instanceof RuntimeInputPublicationError ? operationError :
			new RuntimeInputPublicationError(operationError, { phase: operationStarted ? "verification" : "preflight", mutationStatus: appliedResult?.mutationStatus ?? (operationStarted ? "attempted" : "not-applied") });
		const receipt = { ...failure.receipt, ...(error instanceof ApiRolloutObservationError ? { apiRollout: error.receipt } : {}) };
		process.stdout.write(`${JSON.stringify(receipt)}\n`);
		process.stderr.write("ACK_RUNTIME_INPUTS_INVALID\n");
		process.exitCode = 1;
	}
}
