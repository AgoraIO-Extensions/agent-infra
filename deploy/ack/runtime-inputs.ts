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

type ObjectRecord = Record<string, any>;
type Kubectl = (args: string[], input?: string) => string;
type Files = {
	bootstrap: string;
	templates: string;
	capacity: string;
	requests: string;
	login?: string;
};
type RuntimeInputMutationStatus =
	| "not-applied"
	| "preflight"
	| "secret-write"
	| "local-promotion"
	| "rollout"
	| "verified";
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

async function prepare(files: Files, rendered: string, sourceSha: string) {
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
		return { name, component, secretName: configurationSecret(deployment, component) };
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
	if (files.login) {
		const { verifiedLoginCandidate } = await import("./bootstrap-login.ts");
		const candidate = await verifiedLoginCandidate(files.login, sourceSha, requests.origin);
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
	return { bootstrap, consumers, secrets, writes };
}

export async function publishRuntimeInputs(files: Files, rendered: string, sourceSha: string, kubectl: Kubectl, apply = false, timeout = "300s") {
	const mutation = { status: (apply ? "preflight" : "not-applied") as RuntimeInputMutationStatus };
	try {
		const result = await publishRuntimeInputsUnsafe(files, rendered, sourceSha, kubectl, apply, timeout, mutation);
		return { ...result, mutationStatus: mutation.status };
	} catch (error) {
		if (error && typeof error === "object")
			Object.defineProperty(error, "runtimeInputMutationStatus", { value: mutation.status, enumerable: false });
		throw error;
	}
}

async function publishRuntimeInputsUnsafe(files: Files, rendered: string, sourceSha: string, kubectl: Kubectl, apply: boolean, timeout: string, mutation: { status: RuntimeInputMutationStatus }) {
	const requestInput = await privateJson(files.requests);
	const plan = await prepare(files, rendered, sourceSha);
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
		try {
			return read("secret", name);
		} catch {
			// A missing configuration Secret is an outage risk; keep the failure bounded and do not let kubectl output leak.
			throw new Error("RUNTIME_INPUT_SECRET_MISSING");
		}
	};
	const secrets = plan.secrets.map((entry) => {
		const current = readSecret(entry.desired.metadata.name);
		assert(current.kind === "Secret" && current.metadata?.name === entry.desired.metadata.name && current.metadata.namespace === namespace && current.metadata.uid && current.metadata.resourceVersion &&
			current.metadata.labels?.[ownerLabel] === installationId && current.type === "Opaque" && !current.immutable, "RUNTIME_INPUT_SECRET_OWNER_INVALID");
		assert(isDeepStrictEqual(current.data, entry.before.data) || isDeepStrictEqual(current.data, entry.desired.data), "RUNTIME_INPUT_SECRET_DRIFT");
		return { ...entry, current, verifiedVersion: current.metadata.resourceVersion, changed: !isDeepStrictEqual(current.data, entry.desired.data) };
	});
	const consumers = plan.consumers.map((entry) => {
		const current = read("deployment", entry.name);
		assert(current.kind === "Deployment" && current.metadata?.name === entry.name && current.metadata.uid && current.metadata.resourceVersion && current.metadata.namespace === namespace &&
			configurationSecret(current, entry.component) === entry.secretName, "RUNTIME_INPUT_CONSUMER_DRIFT");
		const data = secrets.find((s) => s.desired.metadata.name === entry.secretName)!.desired.data;
		const revision = hash(JSON.stringify(Object.entries(data).sort(([a], [b]) => a.localeCompare(b))));
		return { ...entry, current, revision, changed: current.spec.template.metadata?.annotations?.[revisionAnnotation] !== revision };
	});
	if (apply) {
		for (const [file, bytes] of plan.writes) assert.deepEqual(await privateBytes(file), bytes.before, "RUNTIME_INPUT_LOCAL_DRIFT");
		mutation.status = "secret-write";
		for (const secret of secrets) {
			assertNamespace();
			const current = readSecret(secret.current.metadata.name);
			assert(current.metadata.uid === secret.current.metadata.uid && current.metadata.resourceVersion === secret.current.metadata.resourceVersion, "RUNTIME_INPUT_SECRET_VERSION_DRIFT");
			if (secret.changed) kubectl(["-n", namespace, "replace", "--field-manager=agent-infra-runtime-inputs", "-f", "-"],
				JSON.stringify({ ...current, data: secret.desired.data }));
			const observed = read("secret", current.metadata.name);
			assert(observed.metadata.uid === current.metadata.uid && observed.metadata.labels?.[ownerLabel] === installationId &&
				isDeepStrictEqual(observed.data, secret.desired.data), "RUNTIME_INPUT_SECRET_READBACK_FAILED");
			secret.verifiedVersion = observed.metadata.resourceVersion;
		}
		mutation.status = "local-promotion";
		for (const [file, bytes] of plan.writes) {
			assert.deepEqual(await privateBytes(file), bytes.before, "RUNTIME_INPUT_LOCAL_DRIFT");
			if (bytes.before.equals(bytes.after)) continue;
			const temporary = `${file}.runtime-inputs-${randomUUID()}`;
			try { await writeFile(temporary, bytes.after, { mode: 0o600, flag: "wx" }); await rename(temporary, file); }
			finally { await unlink(temporary).catch(() => {}); }
		}
		mutation.status = "rollout";
		for (const consumer of consumers) {
			assertNamespace();
			const current = read("deployment", consumer.name);
			assert(current.metadata.uid === consumer.current.metadata.uid && current.metadata.resourceVersion === consumer.current.metadata.resourceVersion, "RUNTIME_INPUT_CONSUMER_VERSION_DRIFT");
			if (consumer.changed) kubectl(["-n", namespace, "patch", "deployment", consumer.name, "--type=merge", "-p", JSON.stringify({
				metadata: { uid: current.metadata.uid, resourceVersion: current.metadata.resourceVersion },
				spec: { template: { metadata: { annotations: { [revisionAnnotation]: consumer.revision } } } },
			})]);
			kubectl(["-n", namespace, "rollout", "status", `deployment/${consumer.name}`, `--timeout=${timeout}`]);
			const observed = read("deployment", consumer.name);
			assert(observed.metadata.uid === current.metadata.uid && observed.spec.template.metadata.annotations?.[revisionAnnotation] === consumer.revision &&
				observed.status?.observedGeneration === observed.metadata.generation && observed.status.updatedReplicas === 1 && observed.status.availableReplicas === 1,
				"RUNTIME_INPUT_CONSUMER_ROLLOUT_FAILED");
		}
		assertNamespace();
		for (const secret of secrets) {
			const current = read("secret", secret.current.metadata.name);
			assert(current.metadata.uid === secret.current.metadata.uid && current.metadata.resourceVersion === secret.verifiedVersion &&
				isDeepStrictEqual(current.data, secret.desired.data), "RUNTIME_INPUT_SECRET_CHANGED_DURING_ROLLOUT");
		}
		if (files.login) {
			const { verifiedLoginCandidate } = await import("./bootstrap-login.ts");
			await verifiedLoginCandidate(files.login, sourceSha, requestInput.origin);
		}
		mutation.status = "verified";
	}
	return { schemaVersion: 1, kind: "ack-runtime-inputs", status: "passed", mode: apply ? "applied-and-read-back" : "read-only-plan", sourceSha,
		secretCount: secrets.length, changedSecretCount: secrets.filter((s) => s.changed).length,
		rolloutCount: consumers.filter((c) => c.changed).length, templateCount: 4, businessVerified: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const [mode, bootstrap, templates, capacity, requests, rendered] = process.argv.slice(2);
		const { ACK_SOURCE_SHA: source, ACK_KUBECONFIG: kubeconfig, ACK_NAMESPACE: namespace } = process.env;
		assert(["plan", "apply"].includes(mode) && source && kubeconfig && namespace);
		assert((await privateJson(bootstrap)).namespace === namespace);
		const run: Kubectl = (args, input) => execFileSync("kubectl", ["--kubeconfig", kubeconfig, ...args], {
			input, encoding: "utf8", timeout: args.includes("rollout") ? 310_000 : 30_000,
			maxBuffer: 16 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
		});
		const result = await publishRuntimeInputs({ bootstrap, templates, capacity, requests, login: process.env.ACK_LOGIN_BOOTSTRAP_FILE || undefined }, await readFile(rendered, "utf8"), source, run, mode === "apply");
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		const failureCode = /^[A-Z][A-Z0-9_]{0,63}$/u.test(message) ? message : "RUNTIME_INPUTS_INVALID";
		const mutationStatus = error && typeof error === "object" &&
			typeof (error as { runtimeInputMutationStatus?: unknown }).runtimeInputMutationStatus === "string"
			? (error as { runtimeInputMutationStatus: RuntimeInputMutationStatus }).runtimeInputMutationStatus
			: "preflight";
		const recoveryRequired = ["secret-write", "local-promotion", "rollout"].includes(mutationStatus);
		process.stdout.write(`${JSON.stringify({ schemaVersion: 1, kind: "ack-runtime-inputs", status: "failed", failureCode, mutationStatus, recoveryRequired })}\n`);
		process.stderr.write("ACK_RUNTIME_INPUTS_INVALID\n");
		process.exitCode = 1;
	}
}
