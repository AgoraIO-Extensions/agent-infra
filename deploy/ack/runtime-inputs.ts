import { paseoTemplateEvidence } from "./paseo-template.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parseAllDocuments } from "yaml";
import { prepareBootstrapInputs } from "./bootstrap-inputs.ts";
import { codexAcsPlacementV1, renderedCodexAcsPlacementV1 } from "./networkpolicy-enforcement.mjs";
import { privateBytes, privateJson } from "./private-input.ts";
import { readTemplateValidationAdoptionInputs, validateTemplateValidationExpectations } from "./template-validation.mjs";
import { adoptTemplateValidationV2, parseAdoptedTemplateValidationV2, templateValidationContextV1Schema } from "../../packages/model-catalog/dist/index.mjs";
import { assertWorkerCapacityPolicy, currentCapacityEvidence, parseRetainedTemplateMeasurements, validateCapacityBindings, validateRetainedTemplateCapacity } from "./workload-capacity.ts";
import { ApiRolloutObservationError, apiReplicaTarget, apiRolloutTools, observeApiRollout } from "./api-rollout-observation.ts";
import { prepareReserveInput, readReserveApi, readReserveWorker } from "./session-reserve-inputs.ts";
import { sessionSandboxReserveDigestV1 } from "../../packages/platform-core/src/session-sandbox-reserves.ts";
import { workloadResourceConfigurationHashV1 } from "../../packages/platform-core/src/workload-resource-configuration.ts";

type ObjectRecord = Record<string, any>;
type Kubectl = (args: string[], input?: string) => string;
type Files = {
	codexTrial?: boolean;
	externalServiceTrial?: boolean;
	trustedTrialTarget?: string;
	bootstrap: string;
	templates: string;
	templateImages?: string;
	capacity: string;
	requests: string;
	login?: string;
	reserves?: string;
};
type PublicationProgress = {
	phase: "preflight" | "secret-write" | "local-promotion" | "rollout" | "login" | "verification";
	mutationStatus: "not-applied" | "attempted" | "applied";
	objects?: Array<{kind: string; name: string; uid: string; resourceVersion: string; state: "attempted" | "verified"}>;
};
const failureCodes = new Set([
	"RUNTIME_INPUTS_INVALID", "RUNTIME_INPUT_COMPUTE_DRIFT", "RUNTIME_INPUT_CODEX_CONSUMER_INVALID", "RUNTIME_INPUT_LOGIN_REQUIRED", "RUNTIME_INPUT_CLUSTER_DRIFT",
	"RUNTIME_INPUT_TRIAL_TARGET_INVALID", "RUNTIME_INPUT_TRIAL_CAPACITY_INVALID", "RUNTIME_INPUT_TRIAL_TEMPLATE_CONFLICT", "RUNTIME_INPUT_RESERVE_CONSUMER_MISMATCH", "RUNTIME_INPUT_TRIAL_CONSUMER_INVALID",
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
	"LOGIN_TRIAL_TARGET_INVALID", "LOGIN_SINGLE_OWNER_INVALID",
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
const allowedTrialNamespace = (files: Files, namespace: string) => files.externalServiceTrial
	? namespace === "agent-infra-ext4425"
	: namespace === "ack-community-m1-4403" || namespace === "ack-community-m1-4405";

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

function consumerRolledOut(deployment: ObjectRecord, revision: string, replicas: number) {
	return !deployment.metadata?.deletionTimestamp && Number.isSafeInteger(deployment.metadata?.generation) &&
		(deployment.spec?.replicas ?? 1) === replicas && deployment.spec?.template?.metadata?.annotations?.[revisionAnnotation] === revision &&
		deployment.status?.observedGeneration === deployment.metadata.generation && deployment.status.replicas === replicas &&
		deployment.status.updatedReplicas === replicas && deployment.status.availableReplicas === replicas && deployment.status.readyReplicas === replicas;
}

const budgetDimensions = ["cpuMillis", "memoryBytes", "storageBytes"] as const;
/**
 * An approved enabled reserve policy whose next revision only raises the declared total budget
 * (ADR-0036). It is not a template change, so it must not force re-adoption of retained records.
 */
export function reserveBudgetIncreaseOnly(before: Uint8Array, after: Uint8Array) {
	let old: any, next: any;
	try {
		old = JSON.parse(Buffer.from(before).toString("utf8"));
		next = JSON.parse(Buffer.from(after).toString("utf8"));
	} catch { return false; }
	const budget = (value: any) => value?.totalBudget && typeof value.totalBudget === "object" && !Array.isArray(value.totalBudget) &&
		Object.keys(value.totalBudget).sort().join() === [...budgetDimensions].sort().join() &&
		budgetDimensions.every((key) => Number.isSafeInteger(value.totalBudget[key]) && value.totalBudget[key] >= 0);
	return Boolean(old && next) && old.enabled === true && next.enabled === true && budget(old) && budget(next) &&
		Number.isSafeInteger(old.revision) && Number.isSafeInteger(next.revision) && next.revision === old.revision + 1 &&
		budgetDimensions.every((key) => next.totalBudget[key] >= old.totalBudget[key]) &&
		budgetDimensions.some((key) => next.totalBudget[key] > old.totalBudget[key]) &&
		isDeepStrictEqual({ ...next, revision: old.revision, totalBudget: old.totalBudget }, old);
}

const reserveLiteralPrefix = "export const sessionSandboxReserves=";
/**
 * A configuration module may also export the reserve policy; the Worker rejects a module/file mismatch.
 * For a budget-only revision, replace exactly the one literal that equals the previous file policy.
 */
export function reserveModuleLiteralSuccessor(module: Uint8Array, before: Uint8Array, after: Uint8Array) {
	const text = Buffer.from(module).toString("utf8");
	const literal = (bytes: Uint8Array) => {
		const { sourceSha: _source, ...policy } = JSON.parse(Buffer.from(bytes).toString("utf8"));
		return `${reserveLiteralPrefix}${JSON.stringify(policy)};`;
	};
	if (text.split("sessionSandboxReserves").length === 1) return undefined;
	const old = literal(before);
	assert(text.split("sessionSandboxReserves").length === 2 && text.split(old).length === 2, "RUNTIME_INPUT_RESERVE_MODULE_CONFLICT");
	return Buffer.from(text.replace(old, () => literal(after)));
}

/** Profiles that prepare() added for retained template images, with their measured receipts. */
type CapacityAppend = { profilesFile: string; capacityFile: string; profiles: ObjectRecord[]; evidence: { imageDigest: string; file: string }[] };
/**
 * A staged capacity write is the planned append only if the published profile document keeps every existing
 * byte (the producer also rewrites its source, so another source differs), and the capacity input keeps every
 * field and evidence entry; each is followed only by the appended profiles and receipts. Any other change,
 * such as a new approval for a current template image or a merged candidate profile, makes the bytes differ.
 */
function capacityAppendWrite(append: CapacityAppend, file: string, { before, after }: { before: Buffer; after: Buffer }) {
	let previous: any;
	try { previous = JSON.parse(before.toString("utf8")); } catch { return false; }
	if (file === append.profilesFile)
		return Array.isArray(previous?.profiles) && jsonBytes(previous).equals(before) &&
			jsonBytes({ ...previous, profiles: [...previous.profiles, ...append.profiles] }).equals(after);
	return file === append.capacityFile && Array.isArray(previous?.evidence) &&
		jsonBytes({ ...previous, evidence: [...previous.evidence, ...append.evidence] }).equals(after);
}

// template-model-preflight wrote owned-resource ledgers with exactly these keys before it recorded templateId.
const legacyOwnedLedgerKeys = "imageDigest,kind,namespace,owner,resources,schemaVersion,sourceCommit";
/**
 * A legacy ledger names no template, so it must be proven to be this run's ledger: the run's Pod startup
 * receipt names the template, source and image and hashes the ledger's Pod UID, and the measured capacity
 * receipt hashes its ServiceAccount, NetworkPolicy and PVC UIDs. The Secret has no receipt hash; it is bound
 * only through the same ledger and object name.
 */
function legacyOwnedLedgerBound(owned: ObjectRecord, startup: any, measured: any, entry: { templateId: string; imageDigest: string }, sourceSha: string) {
	if (!Array.isArray(owned.resources)) return false;
	const uidHash = (kind: string) => {
		const matches = owned.resources.filter((resource: any) => resource?.kind === kind);
		return matches.length === 1 && typeof matches[0].uid === "string" && matches[0].uid ? hash(matches[0].uid) : undefined;
	};
	const pod = uidHash("Pod");
	return pod !== undefined && startup?.schemaVersion === 1 && startup.kind === "ack-template-pod-startup" &&
		startup.templateId === entry.templateId && startup.sourceCommit === sourceSha && startup.imageDigest === entry.imageDigest &&
		startup.podUidSha256 === pod && ([["serviceAccountUidSha256", "ServiceAccount"], ["networkPolicyUidSha256", "NetworkPolicy"],
			["pvcUidSha256", "PersistentVolumeClaim"]] as const).every(([field, kind]) => {
			const uid = uidHash(kind);
			return uid !== undefined && measured[field] === uid;
		});
}

// The API server fills default matchPolicy and rule scope on admissionregistration v1 objects.
function containsRenderedSpec(actual: any, expected: any): boolean {
	if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => containsRenderedSpec(actual[i], v));
	if (expected && typeof expected === "object") return actual && Object.keys(actual).every(key => Object.hasOwn(expected, key) ||
		(key === "matchPolicy" && actual[key] === "Equivalent") || (key === "scope" && actual[key] === "*") ||
		(key === "namespaceSelector" && isDeepStrictEqual(actual[key], {})) || (key === "objectSelector" && isDeepStrictEqual(actual[key], {}))) &&
		Object.entries(expected).every(([key,value]) => containsRenderedSpec(actual[key], value));
	return actual === expected;
}

async function prepare(files: Files, rendered: string, sourceSha: string, kubectl: Kubectl, loginTrialTarget?: unknown) {
	const bootstrap = await privateJson(files.bootstrap);
	const templates = await privateJson(files.templates);
	const capacity = await privateJson(files.capacity);
	const requests = await privateJson(files.requests);
	assert(/^[a-f0-9]{40}$/u.test(sourceSha) && templates.sourceSha === sourceSha && capacity.sourceSha === sourceSha);
	if (files.codexTrial && bootstrap.namespace === "ack-community-m1-4405")
		assert(templates.templates?.length === 1 && templates.templates[0]?.transport === "paseo-sdk-pod" &&
			capacity.codexSessionExecutor === undefined, "RUNTIME_INPUT_TRIAL_TARGET_INVALID");
	const acs = renderedCodexAcsPlacementV1(rendered, bootstrap.namespace);
	let acsRepository: string | undefined;
	if (acs) {
		assert(!files.codexTrial && !files.externalServiceTrial && capacity.codexSessionExecutor === undefined &&
			(capacity.sessionRuntimePlacement?.compute ?? "eci") === acs.session, "RUNTIME_INPUT_COMPUTE_DRIFT");
		assert(files.templateImages, "RUNTIME_INPUT_TEMPLATE_VALIDATION_FAILED");
		const images = await privateJson(files.templateImages);
		const image = images.images?.codex;
		assert(images.commitSha === sourceSha && images.schemaVersion === 1 && images.platform === "linux/amd64" &&
			typeof image?.repository === "string" && image.repository.length > 0 &&
			image.digest === templates.templates?.[0]?.imageDigest, "RUNTIME_INPUT_TEMPLATE_VALIDATION_FAILED");
		acsRepository = image.repository;
	}
	const validationGate = await validateTemplateValidationExpectations(templates, { codexTrial: files.codexTrial, acs: Boolean(acs) });
	assert(validationGate.pass || validationGate.results.every((r: any) => r.status === "passed" || r.reason === "VALIDATION_EXPIRED_OR_CLOCK_INVALID"), "RUNTIME_INPUT_TEMPLATE_VALIDATION_FAILED");
	const objects = await prepareBootstrapInputs(bootstrap, rendered);
	const documents = parseAllDocuments(rendered).map((d) => {
		assert.equal(d.errors.length, 0);
		return d.toJSON();
	}).filter(Boolean);
	const admissions = acs ? documents.filter(d => ["ValidatingAdmissionPolicy", "ValidatingAdmissionPolicyBinding", "MutatingAdmissionPolicy", "MutatingAdmissionPolicyBinding"].includes(d.kind) &&
		d.metadata?.name === bootstrap.namespace + (d.kind.startsWith("Validating") ? "-agent-workload-eci" : "-session-eci")) : [];
	const consumers = (["api", "worker"] as const).map((component) => {
		const name = `agent-infra-${component}`;
		const deployment = documents.find((d) => d.kind === "Deployment" && d.metadata?.name === name);
		assert(deployment, "RUNTIME_INPUT_CONSUMER_MISSING");
		const replicas = deployment.spec?.replicas ?? 1;
		assert(Number.isSafeInteger(replicas) && replicas > 0 && replicas <= 10 && (component !== "worker" || replicas === 1), "RUNTIME_INPUT_REPLICA_COUNT_INVALID");
		const image = deployment.spec.template.spec.containers.find((c: any) => c.name === `platform-${component}`)?.image;
		if (acs) assert(typeof image === "string" && /@sha256:[a-f0-9]{64}$/u.test(image), "RUNTIME_INPUT_CONSUMER_DRIFT");
		return { name, component, image, replicas, secretName: configurationSecret(deployment, component) };
	});
	const secrets = [...new Set(consumers.map((c) => c.secretName))].map((name) => {
		const object = objects.find((o) => o.kind === "Secret" && o.metadata.name === name);
		const binding = bootstrap.objects.find((o: any) => o.kind === "Secret" && o.name === name);
		assert(object?.type === "Opaque" && binding);
		return { before: object, desired: structuredClone(object), files: binding.files };
	});
	const writes = new Map<string, { before: Buffer; after: Buffer }>();
	const reserveTargets = new Set<string>();
	const reserveModules = new Map<string, Buffer>();
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
		const candidate = await verifiedLoginCandidate(files.login, sourceSha, requests.origin, loginTrialTarget);
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
	assert(requests.schemaVersion === 1 && Array.isArray(requests.requests));
	const bodies = await Promise.all(requests.requests.map((r: any) => privateJson(r.bodyFile)));
	assert(templates.templates.every((t: any) => bodies.some((b: any) => b.source?.kind === "standard" && b.source.templateId === t.templateId)), "RUNTIME_INPUT_TEMPLATE_REQUEST_MISSING");
	if (files.codexTrial || acs) {
		assert(bodies.every((b: any) => b.source?.kind === "standard" && b.source.templateId === "codex"), "RUNTIME_INPUT_TRIAL_REQUEST_INVALID");
		if (files.codexTrial && !files.externalServiceTrial) assert(!capacity.retainedTemplateMeasurements?.length, "RUNTIME_INPUT_TRIAL_CAPACITY_INVALID");
	}
	let profiles = profilesDocument.profiles;
	if (capacity.candidateProfilesFile !== undefined && capacity.candidateProfilesFile !== capacity.profilesFile) {
		assert(!Object.values(files).includes(capacity.candidateProfilesFile) && !bootstrap.objects.some((o: any) => Object.values(o.files ?? {}).includes(capacity.candidateProfilesFile)), "RUNTIME_INPUT_CAPACITY_TARGET_INVALID");
		const candidate = await privateJson(capacity.candidateProfilesFile);
		assert(candidate.schemaVersion === 1 && Array.isArray(candidate.profiles), "RUNTIME_INPUT_CAPACITY_TUPLE_INVALID");
		for (const profile of candidate.profiles) {
			const existing = profiles.filter((p: any) => p.imageDigest === profile.imageDigest && p.resourceProfileRef === profile.resourceProfileRef && p.resourceConfigurationHash === profile.resourceConfigurationHash);
			assert(existing.length <= 1, "RUNTIME_INPUT_CAPACITY_AMBIGUOUS");
			if (existing.length) assert.deepEqual(existing[0], profile, "RUNTIME_INPUT_CAPACITY_TUPLE_INVALID");
			else profiles = [...profiles, profile];
		}
	}
	const resources = {
		requests: { cpu: capacity.resources?.requests?.cpu, memory: capacity.resources?.requests?.memory },
		limits: { cpu: capacity.resources?.limits?.cpu, memory: capacity.resources?.limits?.memory },
	};
	const resourceConfigurationHash = workloadResourceConfigurationHashV1({
		resourceProfileRef: capacity.resourceProfileRef,
		...(capacity.sessionRuntimePlacement === undefined ? {} : { sessionRuntimePlacement: capacity.sessionRuntimePlacement }),
		resources,
		...(capacity.codexSessionExecutor === undefined
			? {}
			: { codexSessionExecutor: capacity.codexSessionExecutor }),
		...(capacity.workspaceSnapshotEgress === undefined
			? {}
			: { workspaceSnapshotEgress: capacity.workspaceSnapshotEgress }),
	});
	assert(Array.isArray(capacity.evidence) && capacity.evidence.length <= 64);
	const evidenceFiles: { imageDigest: string; file: string }[] = [...capacity.evidence];
	const evidence = await currentCapacityEvidence(evidenceFiles, profiles, capacity);
	// One measured receipt either becomes the first full-key approval or re-verifies the existing one.
	// Returns the new approval, if any.
	const adoptMeasuredProfile = async (request: any, template: { templateId: string; imageDigest: string }, file: string, measuredBytes: Buffer) => {
		const freshProfile = {
			schemaVersion: 1, imageDigest: template.imageDigest, resourceProfileRef: capacity.resourceProfileRef,
			resourceConfigurationHash, maximumConcurrentExecutions: 1, conformanceEvidenceHash: hash(measuredBytes),
		};
		validateCapacityBindings([request], [template], capacity, [freshProfile], new Map([[template.imageDigest, measuredBytes]]));
		const matches = (p: any) => p.imageDigest === template.imageDigest && p.resourceProfileRef === capacity.resourceProfileRef && p.resourceConfigurationHash === resourceConfigurationHash;
		const approved = profiles.filter(matches);
		if (files.codexTrial && !files.externalServiceTrial && profiles.length) {
			assert(profiles.length === 1 && approved.length === 1, "RUNTIME_INPUT_TRIAL_CAPACITY_INVALID");
		}
		assert(approved.length <= 1, "RUNTIME_INPUT_CAPACITY_AMBIGUOUS");
		if (approved.length === 0) {
			if (profiles.some((p: any) => p.imageDigest === template.imageDigest))
				assert(evidenceFiles.some(entry => entry.imageDigest === template.imageDigest), "RUNTIME_INPUT_CAPACITY_TUPLE_INVALID");
			profiles = [...profiles, freshProfile];
			const previous = evidence.get(template.imageDigest);
			if (previous) {
				// An unapproved current-policy input can be replaced. Other approved policies keep their files.
				for (const [index, entry] of evidenceFiles.entries()) {
					if (entry.imageDigest === template.imageDigest && previous.equals(await privateBytes(entry.file))) {
						evidenceFiles[index] = { imageDigest: template.imageDigest, file };
						break;
					}
				}
			} else evidenceFiles.push({ imageDigest: template.imageDigest, file });
			evidence.set(template.imageDigest, measuredBytes);
			return freshProfile;
		} else {
			// Workload dispatch binds the full approval; refreshing validation must not revoke it.
			const previousBytes = evidence.get(template.imageDigest);
			assert(previousBytes, "RUNTIME_INPUT_CAPACITY_TUPLE_INVALID");
			const previous = JSON.parse(previousBytes.toString("utf8"));
			assert(previous.scope === "ack-runtime-capacity" && previous.sourceCommit === sourceSha, "RUNTIME_INPUT_CAPACITY_TUPLE_INVALID");
			validateCapacityBindings([request], [template], capacity, approved, new Map([[template.imageDigest, previousBytes]]));
		}
		return undefined;
	};
	const retainedAppends: { profile: ObjectRecord; evidence: { imageDigest: string; file: string } }[] = [];
	for (const expected of templates.templates) {
		const key = `template-validation-${expected.templateId}.json`;
		for (const secret of secrets) {
			assert(typeof secret.files[key] === "string", "RUNTIME_INPUT_TEMPLATE_TARGET_MISSING");
		}
		const file = join(dirname(expected.validationFile), "runtime-capacity.receipt.json");
		const measuredBytes = await privateBytes(file);
		const measured = JSON.parse(measuredBytes.toString("utf8"));
		if (acs) assert((acs.session === "acs" ? /^acs-[a-z0-9]{1,64}$/u : /^eci-[a-z0-9]{1,64}$/u).test(measured.computeInstanceId ?? ""), "RUNTIME_INPUT_COMPUTE_DRIFT");
		const preflight = await privateJson(expected.preflightFile);
		assert(measured.scope === "ack-runtime-capacity" && measured.sourceCommit === sourceSha &&
				measured.transport === expected.transport && preflight.transport === expected.transport &&
			measured.imageDigest === expected.imageDigest && measured.completedAt === preflight.validatedAt &&
			measured.modelOperationCount === preflight.modelOperationCount, "RUNTIME_INPUT_CAPACITY_TUPLE_INVALID");
		const request = bodies.find((b: any) => b.source?.kind === "standard" && b.source.templateId === expected.templateId);
		await adoptMeasuredProfile(request, expected, file, measuredBytes);
	}
	// Active standard Agents may stay on a retained image; their capacity needs that image's own measurement.
	const retained = parseRetainedTemplateMeasurements(capacity.retainedTemplateMeasurements, templates.templates, Boolean(acs));
	if (files.codexTrial) assert(retained.every((entry) => entry.templateId === "codex"), "RUNTIME_INPUT_TRIAL_CAPACITY_INVALID");
	const retainedTargets: unknown[] = [];
	for (const entry of retained) {
		const file = join(entry.measurementDirectory, "runtime-capacity.receipt.json");
		const measuredBytes = await privateBytes(file);
		const measured = JSON.parse(measuredBytes.toString("utf8"));
		const preflight = await privateJson(join(entry.measurementDirectory, "template-model-validation.receipt.json"));
		const owned = await privateJson(join(entry.measurementDirectory, "owned-resource-identities.json"));
		// The V2 target schema carries only the deployment identity; template and image bind through the same receipt.
		// Strict parsing rejects any extra identity claim on the target, so it cannot name another template or image.
		const parsedTarget = templateValidationContextV1Schema.safeParse(preflight.validationTarget);
		assert(parsedTarget.success && isDeepStrictEqual(parsedTarget.data, preflight.validationTarget), "RUNTIME_INPUT_CAPACITY_TUPLE_INVALID");
		const target = parsedTarget.data;
		assert(measured.scope === "ack-runtime-capacity" && measured.sourceCommit === sourceSha && measured.imageDigest === entry.imageDigest &&
			(preflight.schemaVersion === 2 || (preflight.schemaVersion === 3 && preflight.transportEvidence === paseoTemplateEvidence(entry.templateId,preflight.transport) &&
				typeof preflight.executionId === "string" && preflight.executionId.length > 0)) &&
			(preflight.transport !== "paseo-sdk-pod" && measured.transport !== "paseo-sdk-pod" && entry.transport === undefined || (entry.transport === preflight.transport && entry.transport === measured.transport)) &&
			preflight.scope === "isolated-template-real-model" && preflight.templateId === entry.templateId &&
			preflight.sourceCommit === sourceSha && preflight.imageDigest === entry.imageDigest && preflight.terminalStatus === "completed" &&
			measured.completedAt === preflight.validatedAt && measured.modelOperationCount === preflight.modelOperationCount &&
			target?.sourceCommit === sourceSha && target.namespace === bootstrap.namespace && target.clusterUid === bootstrap.clusterUid &&
			target.installationId === bootstrap.installationId, "RUNTIME_INPUT_CAPACITY_TUPLE_INVALID");
		// A standalone run is usable only after every temporary object it created was retired by UID.
		// The ledger's templateId and object names bind it to this template run and owner, as template-model-preflight writes them.
		const ownedKinds = ["Pod", "Secret", "PersistentVolumeClaim", "NetworkPolicy", "ServiceAccount"];
		const executorNamed = entry.templateId === "codex" && entry.transport === undefined && capacity.codexSessionExecutor !== undefined;
		const ownedName = typeof owned.owner !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(owned.owner) ? undefined
			: executorNamed ? `sandbox-preflight-${owned.owner}`
				: `ack-preflight-${entry.templateId}-${owned.owner.slice(0, 8)}`;
		// A ledger in the exact pre-templateId shape carries the template only in its object names,
		// so the same run's startup and capacity receipts must also bind its UIDs.
		const legacyOwned = !executorNamed && Object.keys(owned).sort().join() === legacyOwnedLedgerKeys;
		const startup = legacyOwned ? await privateJson(join(entry.measurementDirectory, "pod-startup.receipt.json")) : undefined;
		assert(ownedName && owned.schemaVersion === 1 && owned.kind === "ack-template-owned-resources" &&
			(legacyOwned ? legacyOwnedLedgerBound(owned, startup, measured, entry, sourceSha) : owned.templateId === entry.templateId) &&
			owned.sourceCommit === sourceSha &&
			owned.imageDigest === entry.imageDigest && owned.namespace === bootstrap.namespace && Array.isArray(owned.resources) &&
			owned.resources.length === ownedKinds.length && ownedKinds.every((kind) => owned.resources.filter((resource: any) =>
				resource?.kind === kind && resource.name === ownedName && typeof resource.uid === "string" && resource.uid.length > 0 &&
				["deleted", "absent"].includes(resource.state)).length === 1), "RUNTIME_INPUT_CAPACITY_TUPLE_INVALID");
		retainedTargets.push(target);
		const added = await adoptMeasuredProfile({ source: { kind: "standard", templateId: entry.templateId } }, entry, file, measuredBytes);
		if (added) retainedAppends.push({ profile: added, evidence: { imageDigest: entry.imageDigest, file } });
	}
	if (files.codexTrial) {
		const digests = new Set([templates.templates[0].imageDigest, ...retained.map((entry) => entry.imageDigest)]);
		assert(profiles.every((p: any) => digests.has(p.imageDigest) && p.resourceProfileRef === capacity.resourceProfileRef &&
			p.resourceConfigurationHash === resourceConfigurationHash) && new Set(profiles.map((p: any) => p.imageDigest)).size === profiles.length &&
			evidenceFiles.every((entry) => digests.has(entry.imageDigest)) && new Set(evidenceFiles.map(e => e.imageDigest)).size === evidenceFiles.length, "RUNTIME_INPUT_TRIAL_CAPACITY_INVALID");
	}
	assert(evidenceFiles.length <= 64 && profiles.length <= 64);
	validateCapacityBindings(bodies, templates.templates, capacity, profiles, evidence);
	validateRetainedTemplateCapacity(retained, capacity, profiles, evidence);
	const worker = consumers.find((c) => c.component === "worker")!;
	assert(capacity.workerSecretRef?.name === worker.secretName);
	const workerSecret = secrets.find((s) => s.desired.metadata.name === worker.secretName)!;
	assert(workerSecret.files[capacity.workerSecretRef.key] === capacity.profilesFile, "RUNTIME_INPUT_CAPACITY_TARGET_INVALID");
	const profileBytes = jsonBytes({ ...profilesDocument, sourceSha, profiles });
	await stageFile(capacity.profilesFile, profileBytes);
	if (capacity.candidateProfilesFile !== undefined) await stageFile(capacity.candidateProfilesFile, profileBytes);
	workerSecret.desired.data[capacity.workerSecretRef.key] = profileBytes.toString("base64");
	await stageFile(files.capacity, jsonBytes({ ...capacity, evidence: evidenceFiles }));
	// A successor may publish exactly this append without re-adopting templates (publishRuntimeInputsWithProgress).
	const capacityAppend: CapacityAppend | undefined = retainedAppends.length === 0 ? undefined : {
		profilesFile: capacity.profilesFile, capacityFile: files.capacity,
		profiles: retainedAppends.map((entry) => entry.profile), evidence: retainedAppends.map((entry) => entry.evidence),
	};
	if (files.reserves) {
		const apiConsumer = consumers.find((c) => c.component === "api");
		assert(apiConsumer, "RUNTIME_INPUT_CONSUMER_MISSING");
		await prepareReserveInput({
			ACK_BOOTSTRAP_INPUTS_FILE: files.bootstrap,
			ACK_SESSION_RESERVES_FILE: files.reserves,
			ACK_NAMESPACE: bootstrap.namespace,
			ACK_WORKLOAD_CAPACITY_FILE: files.capacity,
			ACK_TEMPLATE_VALIDATIONS_FILE: files.templates,
		}, sourceSha, {
			workerSecretName: worker.secretName,
			apiSecretName: apiConsumer.secretName,
			requireAdoption: false,
			readWorker: (environment, input, name) => readReserveWorker({ ...environment, ACK_SOURCE_SHA: sourceSha }, input, name, kubectl, false),
		});
		const bytes = await privateBytes(files.reserves);
		const publishedBootstrap = structuredClone(bootstrap);
		let changedBindings = false;
		for (const consumer of consumers) {
			const secret = secrets.find((s) => s.desired.metadata.name === consumer.secretName)!;
			const target = secret.files["session-reserves.json"] ?? files.reserves;
			reserveTargets.add(target);
			await stageFile(target, bytes);
			secret.desired.data["session-reserves.json"] = bytes.toString("base64");
			const previous = writes.get(target)!.before;
			const moduleFile = secret.files["configuration.mjs"];
			if (typeof moduleFile === "string" && reserveBudgetIncreaseOnly(previous, bytes)) {
				const next = reserveModuleLiteralSuccessor(await privateBytes(moduleFile), previous, bytes);
				if (next) {
					await stageFile(moduleFile, next);
					reserveModules.set(moduleFile, next);
					secret.desired.data["configuration.mjs"] = next.toString("base64");
				}
			}
			if (!secret.files["session-reserves.json"]) {
				publishedBootstrap.objects.find((object: any) => object.kind === "Secret" && object.name === consumer.secretName).files["session-reserves.json"] = target;
				changedBindings = true;
			}
		}
		if (changedBindings) await stageFile(files.bootstrap, jsonBytes(publishedBootstrap));
	}
	return { acs, acsRepository, admissions, capacity, profiles, resourceConfigurationHash, retained, bootstrap, consumers, secrets, writes, loginCandidate, origin: requests.origin, templates, stageFile, validationGate, retainedTargets, reserveTargets, reserveModules, capacityAppend };
}

// A successor plan targets mounted immutable configuration Secrets. It adopts and validates the same final
// bytes as apply, but writes no Secret or Deployment; the Helm-owned publisher must create new Secrets and rebind.
export type PublicationOptions = { successor?: boolean };

export async function publishRuntimeInputs(files: Files, rendered: string, sourceSha: string, kubectl: Kubectl, apply = false, timeout = "300s", options: PublicationOptions = {}) {
	const progress: PublicationProgress = { phase: "preflight", mutationStatus: "not-applied" };
	try {
		assert(!apply || files.login, "RUNTIME_INPUT_LOGIN_REQUIRED");
		assert(!apply || !options.successor, "RUNTIME_INPUTS_INVALID");
		assert(!(files.codexTrial && files.externalServiceTrial), "RUNTIME_INPUT_TRIAL_TARGET_INVALID");
		// Both isolated scopes use the same Codex-only gates, with distinct fixed targets.
		const scoped = files.externalServiceTrial ? { ...files, codexTrial: true } : files;
		const result = await publishRuntimeInputsWithProgress(scoped, rendered, sourceSha, kubectl, apply, timeout, progress, options.successor === true);
		return { ...result, mutationStatus: progress.mutationStatus };
	} catch (error) {
		throw new RuntimeInputPublicationError(error, progress);
	}
}

async function publishRuntimeInputsWithProgress(files: Files, rendered: string, sourceSha: string, kubectl: Kubectl, apply: boolean, timeout: string, progress: PublicationProgress, successor = false) {
	// Operator-provided authority, independent of the bootstrap and measurement files.
	const trusted = files.codexTrial && files.trustedTrialTarget
		? templateValidationContextV1Schema.parse(await privateJson(files.trustedTrialTarget)) : undefined;
	if (files.codexTrial) {
		assert(trusted && trusted.sourceCommit === sourceSha && allowedTrialNamespace(files, trusted.namespace), "RUNTIME_INPUT_TRIAL_TARGET_INVALID");
		const bootstrap = await privateJson(files.bootstrap);
		assert(bootstrap.clusterUid === trusted.clusterUid && bootstrap.installationId === trusted.installationId && bootstrap.namespace === trusted.namespace, "RUNTIME_INPUT_TRIAL_TARGET_INVALID");
		const ns = JSON.parse(kubectl(["get", "namespace", trusted.namespace, "-o", "json"]));
		const cluster = JSON.parse(kubectl(["get", "namespace", "kube-system", "-o", "json"]));
		assert(cluster.metadata?.uid === trusted.clusterUid && ns.metadata?.uid === trusted.namespaceUid &&
			ns.metadata.labels?.[ownerLabel] === trusted.installationId && !ns.metadata.deletionTimestamp, "RUNTIME_INPUT_TRIAL_TARGET_INVALID");
	}
	const loginTrialTarget = files.externalServiceTrial ? trusted : undefined;
	const plan = await prepare(files, rendered, sourceSha, kubectl, loginTrialTarget);
	const { namespace, clusterUid, installationId } = plan.bootstrap;
	const read = (kind: string, name: string, scoped = true) => JSON.parse(kubectl([
		...(scoped ? ["-n", namespace] : []), "get", kind, name, "-o", "json",
	]));
	assert(read("namespace", "kube-system", false).metadata?.uid === clusterUid, "RUNTIME_INPUT_CLUSTER_DRIFT");
	const ns = read("namespace", namespace, false);
	assert(ns.metadata?.uid && !ns.metadata.deletionTimestamp && ns.metadata.labels?.[ownerLabel] === installationId, "RUNTIME_INPUT_NAMESPACE_OWNER_INVALID");
	const assertWorkerPlacement = () => {
		assert.deepEqual(codexAcsPlacementV1(read("deployment", "agent-infra-worker"), namespace), plan.acs, "RUNTIME_INPUT_COMPUTE_DRIFT");
		if (plan.acs) {
			for (const rendered of plan.admissions) {
				const active = read(rendered.kind.toLowerCase(), rendered.metadata.name, false);
				assert(active.metadata?.name === rendered.metadata.name && !active.metadata.deletionTimestamp && active.kind === rendered.kind &&
					containsRenderedSpec(active.spec, rendered.spec), "RUNTIME_INPUT_COMPUTE_DRIFT");
			}
		}
	};
	assertWorkerPlacement();
	const assertNamespace = () => {
		if (plan.acs) assertWorkerPlacement();
		const current = read("namespace", namespace, false);
		assert(current.metadata?.uid === ns.metadata.uid && !current.metadata.deletionTimestamp && current.metadata.labels?.[ownerLabel] === installationId, "RUNTIME_INPUT_NAMESPACE_DRIFT");
	};
	const validationContext = templateValidationContextV1Schema.parse({
		sourceCommit: sourceSha, clusterUid, namespace, namespaceUid: ns.metadata.uid, installationId,
	});
	if (files.codexTrial) assert(isDeepStrictEqual(validationContext, trusted), "RUNTIME_INPUT_TRIAL_TARGET_INVALID");
	for (const target of plan.retainedTargets)
		assert(isDeepStrictEqual(templateValidationContextV1Schema.safeParse(target).data, validationContext), "RUNTIME_INPUT_CAPACITY_TARGET_INVALID");
	const adoptionInputs = await readTemplateValidationAdoptionInputs(plan.templates, validationContext, files.codexTrial, Boolean(plan.acs));
	const assertCandidateFiles = async () => {
		for (const input of adoptionInputs) {
			assert.deepEqual(await privateBytes(input.validationFile), input.candidateBytes, "RUNTIME_INPUT_LOCAL_DRIFT");
			assert.deepEqual(await privateBytes(input.preflightFile), input.preflightBytes, "RUNTIME_INPUT_LOCAL_DRIFT");
		}
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
	const readSecrets = plan.secrets.map((entry) => {
		const current = readSecret(entry.desired.metadata.name);
		assert(current.kind === "Secret" && current.metadata?.name === entry.desired.metadata.name && current.metadata.namespace === namespace && current.metadata.uid && current.metadata.resourceVersion &&
			current.metadata.labels?.[ownerLabel] === installationId && !current.metadata.deletionTimestamp && current.type === "Opaque" &&
			(successor ? current.immutable === true : !current.immutable), "RUNTIME_INPUT_SECRET_OWNER_INVALID");
		if (files.codexTrial) {
			for (const data of [current.data, entry.desired.data]) {
				assert(Object.keys(data).every(key => !key.startsWith("template-validation-") || key === "template-validation-codex.json" ||
					(files.externalServiceTrial && ["claude", "opencode", "pi"].some(template => key === `template-validation-${template}.json`) &&
						Buffer.from(data[key], "base64").toString("utf8").trim() === "{}")), "RUNTIME_INPUT_TRIAL_TEMPLATE_CONFLICT");
			}
		}
		return { ...entry, current };
	});
	const existingAdoptionBytes = new Map<string, Buffer>();
	let fullyAdopted = true;
	for (const input of adoptionInputs) {
		const key = `template-validation-${input.templateId}.json`;
		let bytes: Buffer | undefined;
		try {
			for (const secret of readSecrets) {
				const current = Buffer.from(secret.current.data[key], "base64");
				const record = parseAdoptedTemplateValidationV2(JSON.parse(current.toString("utf8")), validationContext, Date.now());
				assert.deepEqual(record.candidate, input.candidate);
				assert.equal(record.adoption.provenance.candidateFileSha256, input.candidateFileSha256);
				assert.equal(record.adoption.provenance.preflightFileSha256, input.preflightFileSha256);
				if (bytes) assert.deepEqual(current, bytes);
				bytes = current;
			}
			assert(bytes);
			existingAdoptionBytes.set(input.templateId, bytes);
		} catch {
			fullyAdopted = false;
		}
	}
	const matchingAdoptionRecords = fullyAdopted;
	if (matchingAdoptionRecords) {
		for (const input of adoptionInputs) {
			const bytes = existingAdoptionBytes.get(input.templateId)!;
			const key = `template-validation-${input.templateId}.json`;
			for (const secret of plan.secrets) {
				await plan.stageFile(secret.files[key], bytes);
				secret.desired.data[key] = bytes.toString("base64");
			}
		}
		// Matching Secret records alone cannot complete an interrupted publication after expiry.
		const api = plan.consumers.find((consumer) => consumer.component === "api")!;
		const loginTarget = plan.secrets.find((secret) => secret.desired.metadata.name === api.secretName)!.files["deployment-identities.json"];
		// An approved budget-only reserve revision keeps the retained adoption bytes; any other change re-adopts.
		// Only the immutable successor path (new Secrets, Helm-owned rebind) may carry it.
		const budgetOnly = (file: string, bytes: { before: Buffer; after: Buffer }) =>
			successor && ((plan.reserveTargets.has(file) && reserveBudgetIncreaseOnly(bytes.before, bytes.after)) ||
				(plan.reserveModules.get(file)?.equals(bytes.after) === true));
		// The successor may instead carry exactly the planned capacity append, with every other staged byte unchanged.
		const append = successor ? plan.capacityAppend : undefined;
		const capacityAppendOnly = append !== undefined &&
			[...plan.writes].every(([file, bytes]) => bytes.before.equals(bytes.after) || capacityAppendWrite(append, file, bytes));
		fullyAdopted = ([...plan.writes].every(([file, bytes]) => file === loginTarget || bytes.before.equals(bytes.after) || budgetOnly(file, bytes)) ||
			capacityAppendOnly) &&
			readSecrets.every((secret) => isDeepStrictEqual(secret.current.data, secret.before.data)) &&
			plan.consumers.every((consumer) => {
				const current = read("deployment", consumer.name);
				// Check the completed published generation before any independent login refresh.
				const data = readSecrets.find((secret) => secret.desired.metadata.name === consumer.secretName)!.current.data;
				const revision = hash(JSON.stringify(Object.entries(data).sort(([a], [b]) => a.localeCompare(b))));
				return current.kind === "Deployment" && current.metadata?.name === consumer.name && current.metadata.namespace === namespace &&
					current.metadata.uid && current.metadata.resourceVersion && configurationSecret(current, consumer.component) === consumer.secretName &&
					consumerRolledOut(current, revision, consumer.replicas);
			});
	}
	const stillFresh = async () => {
		if (plan.acs) assertWorkerPlacement();
		await assertCandidateFiles();
		const now = Date.now();
		// Recheck the pinned evidence, never a newly replaced file's time window.
		assert(adoptionInputs.every((input: any) => input.candidate.validatedAt <= now &&
			input.candidate.validUntil > now + plan.templates.minValidityMs && input.candidate.validUntil > input.candidate.validatedAt),
			"RUNTIME_INPUT_TEMPLATE_VALIDATION_FAILED");
	};
	if (!fullyAdopted) await stillFresh();
	const adoptionBytes = new Map<string, Buffer>();
	if (apply || successor) {
		const identities = adoptionInputs.map((i: any) => [i.templateId, i.candidateFileSha256, i.preflightFileSha256]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
		const attemptKey = hash(JSON.stringify([validationContext, identities]));
		const attemptFile = join(dirname(files.templates), `.template-adoption-${attemptKey}.json`);
		let attemptInsideGit = false;
		try { attemptInsideGit = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dirname(attemptFile), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() === "true"; } catch {}
		assert(!attemptInsideGit, "RUNTIME_INPUT_FILE_INSIDE_WORKTREE");
		let frozen: any;
		if (!fullyAdopted) {
			try { frozen = await privateJson(attemptFile); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			if (frozen) assert(frozen.schemaVersion === 1 && frozen.kind === "template-adoption-attempt" && Array.isArray(frozen.records) && frozen.records.length === adoptionInputs.length, "RUNTIME_INPUT_TEMPLATE_VALIDATION_FAILED");
		}
		const adoptedAt = Date.now();
		for (const input of adoptionInputs) {
			let bytes: Buffer;
			if (matchingAdoptionRecords) bytes = existingAdoptionBytes.get(input.templateId)!;
			else if (frozen) {
				const records = frozen.records.filter((r: any) => r.templateId === input.templateId);
				assert(records.length === 1 && typeof records[0].bytes === "string", "RUNTIME_INPUT_TEMPLATE_VALIDATION_FAILED");
				bytes = Buffer.from(records[0].bytes, "base64");
				const record = parseAdoptedTemplateValidationV2(JSON.parse(bytes.toString("utf8")), validationContext, adoptedAt);
				assert.deepEqual(record.candidate, input.candidate);
				assert.equal(record.adoption.provenance.candidateFileSha256, input.candidateFileSha256);
				assert.equal(record.adoption.provenance.preflightFileSha256, input.preflightFileSha256);
			} else bytes = jsonBytes(adoptTemplateValidationV2({ ...input, context: validationContext, adoptedAt }));
			adoptionBytes.set(input.templateId, bytes);
		}
		if (!fullyAdopted && !frozen) {
			await stillFresh();
			await writeFile(attemptFile, jsonBytes({ schemaVersion: 1, kind: "template-adoption-attempt", records: [...adoptionBytes].map(([templateId, bytes]) => ({ templateId, bytes: bytes.toString("base64") })) }), { mode: 0o600, flag: "wx" });
		}
	}
	for (const input of adoptionInputs) {
		const bytes = apply || successor ? adoptionBytes.get(input.templateId)! : matchingAdoptionRecords ? existingAdoptionBytes.get(input.templateId)! : input.candidateBytes;
		const key = `template-validation-${input.templateId}.json`;
		for (const secret of plan.secrets) {
			await plan.stageFile(secret.files[key], bytes);
			secret.desired.data[key] = bytes.toString("base64");
		}
	}
	const secrets = readSecrets.map((entry) => {
		const before = { ...entry.before.data };
		if (adoptionInputs.every((input: any) => entry.current.data[`template-validation-${input.templateId}.json`] === entry.desired.data[`template-validation-${input.templateId}.json`]))
			for (const input of adoptionInputs) before[`template-validation-${input.templateId}.json`] = entry.desired.data[`template-validation-${input.templateId}.json`];
		assert(isDeepStrictEqual(entry.current.data, before) || isDeepStrictEqual(entry.current.data, entry.desired.data), "RUNTIME_INPUT_SECRET_DRIFT");
		return { ...entry, verifiedVersion: entry.current.metadata.resourceVersion, changed: !isDeepStrictEqual(entry.current.data, entry.desired.data) };
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
	const verifyCodexConsumer = async (consumer: typeof consumers[number], current: ObjectRecord, bindingOnly: boolean) => {
		try {
			const component = consumer.component;
			const containerName = `platform-${component}`;
			const pods = JSON.parse(kubectl(["-n", namespace, "get", "pods", "-l", `app.kubernetes.io/name=agent-infra,app.kubernetes.io/component=${containerName}`, "-o", "json"])).items.filter((pod: any) => !pod.metadata.deletionTimestamp);
			assert.equal(pods.length, consumer.replicas);
			const record = JSON.parse(adoptionBytes.get("codex")!.toString("utf8"));
			const activeProfiles = plan.profiles.filter((profile: any) => profile.imageDigest === record.candidate.imageDigest &&
				profile.resourceProfileRef === plan.capacity.resourceProfileRef && profile.resourceConfigurationHash === plan.resourceConfigurationHash);
			assert.equal(activeProfiles.length, 1, "RUNTIME_INPUT_TRIAL_CAPACITY_INVALID");
			const expected = { record, profile: activeProfiles[0], profiles: plan.profiles,
				retainedPairs: plan.retained.map(({ templateId, imageDigest }) => ({ templateId, imageDigest })),
				bindingOnly, acsRepository: plan.acsRepository, externalServiceTrial: files.externalServiceTrial === true };
			const probe = await readFile(new URL("./trial-consumer-readback.mjs", import.meta.url), "utf8");
			for (const pod of pods) {
				if (plan.acs) {
					for (const spec of [current.spec.template.spec, pod.spec]) assert.equal(spec.containers.find((c: any) => c.name === containerName)?.image, consumer.image);
					const runningId = pod.status?.containerStatuses?.find((c: any) => c.name === containerName)?.imageID;
					assert(typeof runningId === "string" && runningId.split("@").at(-1) === consumer.image.split("@")[1]);
				}
				const owner = pod.metadata.ownerReferences?.find((o: any) => o.controller && o.kind === "ReplicaSet");
				const rs = read("replicaset", owner.name);
				assert(rs.metadata.uid === owner.uid && rs.metadata.ownerReferences.some((o: any) => o.controller && o.kind === "Deployment" && o.uid === current.metadata.uid));
				assert(pod.metadata.namespace === namespace && pod.metadata.annotations?.[revisionAnnotation] === current.spec.template.metadata?.annotations?.[revisionAnnotation] &&
					pod.status?.containerStatuses?.find((c: any) => c.name === containerName)?.ready);
				const volumes = pod.spec.volumes.filter((v: any) => v.secret?.secretName === consumer.secretName && !v.secret.items);
				const mounts = pod.spec.containers.find((c: any) => c.name === containerName).volumeMounts.filter((m: any) => m.readOnly && !m.subPath && volumes.some((v: any) => v.name === m.name));
				assert(mounts.length > 0 && expected.profile);
				const recordFile = join(mounts[0].mountPath, "template-validation-codex.json");
				const readback = kubectl(["-n", namespace, "exec", "-i", pod.metadata.name, "-c", containerName, "--", "node", "--input-type=module", "-", component, JSON.stringify({...expected, recordFile})], probe);
				if (!bindingOnly && component === "worker") assertWorkerCapacityPolicy(JSON.parse(readback), plan.capacity, expected.profile.resourceConfigurationHash);
				else assert.equal(readback, "verified");
				const end = read("pod", pod.metadata.name);
				assert(end.metadata.uid === pod.metadata.uid && !end.metadata.deletionTimestamp && isDeepStrictEqual(end.status.containerStatuses, pod.status.containerStatuses));
			}
			if (!bindingOnly) assertPublishedSecrets();
		} catch { throw new Error(plan.acs ? "RUNTIME_INPUT_CODEX_CONSUMER_INVALID" : "RUNTIME_INPUT_TRIAL_CONSUMER_INVALID"); }
	};
	const recordAttempt = (kind: string, metadata: ObjectRecord) => {
		if (!files.codexTrial) return;
		const entry: NonNullable<PublicationProgress["objects"]>[number] = {kind, name: metadata.name, uid: metadata.uid, resourceVersion: metadata.resourceVersion, state: "attempted"};
		(progress.objects ??= []).push(entry);
		return entry;
	};
	if (apply) {
		await assertCandidateFiles();
		for (const [file, bytes] of plan.writes) assert.deepEqual(await privateBytes(file), bytes.before, "RUNTIME_INPUT_LOCAL_DRIFT");
		assertNamespace();
		for (const secret of secrets) {
			const current = readSecret(secret.current.metadata.name);
			assert(current.metadata.uid === secret.current.metadata.uid && current.metadata.resourceVersion === secret.current.metadata.resourceVersion &&
				current.metadata.labels?.[ownerLabel] === installationId && !current.metadata.deletionTimestamp, "RUNTIME_INPUT_SECRET_VERSION_DRIFT");
		}
		if (plan.acs || files.codexTrial && namespace === "ack-community-m1-4405") {
			for (const consumer of consumers) {
				// A Secret change must roll new Pods; a matching old annotation cannot prove the running module was reloaded.
				const secret = secrets.find((entry) => entry.desired.metadata.name === consumer.secretName)!;
				assert(!secret.changed || consumer.changed, "RUNTIME_INPUT_CONSUMER_DRIFT");
				const current = read("deployment", consumer.name);
				assert(current.metadata.resourceVersion === consumer.current.metadata.resourceVersion &&
					current.metadata.uid === consumer.current.metadata.uid &&
					consumerRolledOut(current, current.spec.template.metadata?.annotations?.[revisionAnnotation], consumer.replicas),
					"RUNTIME_INPUT_CONSUMER_DRIFT");
				await verifyCodexConsumer(consumer, current, true);
			}
		}
		const apiSecretName = consumers.find((consumer) => consumer.component === "api")!.secretName;
		// Publish directory adoption last, after the Worker's matching evidence is present.
		const writeOrder = [...secrets.filter((s) => s.current.metadata.name !== apiSecretName), ...secrets.filter((s) => s.current.metadata.name === apiSecretName)];
		progress.phase = "secret-write";
		for (const secret of writeOrder) {
			assertNamespace();
			const current = readSecret(secret.current.metadata.name);
			assert(current.metadata.uid === secret.current.metadata.uid && current.metadata.resourceVersion === secret.current.metadata.resourceVersion &&
				current.metadata.labels?.[ownerLabel] === installationId && !current.metadata.deletionTimestamp, "RUNTIME_INPUT_SECRET_VERSION_DRIFT");
			let attempt;
			if (secret.changed) {
				if (!fullyAdopted) await stillFresh();
				progress.mutationStatus = "attempted";
				attempt = recordAttempt("Secret", current.metadata);
				kubectl(["-n", namespace, "replace", "--field-manager=agent-infra-runtime-inputs", "-f", "-"],
					JSON.stringify({ ...current, data: secret.desired.data }));
			}
			const observed = readSecret(current.metadata.name);
			assert(observed.metadata.uid === current.metadata.uid && observed.metadata.labels?.[ownerLabel] === installationId && !observed.metadata.deletionTimestamp &&
				isDeepStrictEqual(observed.data, secret.desired.data), "RUNTIME_INPUT_SECRET_READBACK_FAILED");
			secret.verifiedVersion = observed.metadata.resourceVersion;
			if (attempt) Object.assign(attempt, { state: "verified", resourceVersion: secret.verifiedVersion });
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
			let attempt;
			if (consumer.changed) {
				if (files.codexTrial && !fullyAdopted) await stillFresh();
				attempt = recordAttempt("Deployment", current.metadata);
				progress.mutationStatus = "attempted";
				kubectl(["-n", namespace, "patch", "deployment", consumer.name, "--type=merge", "-p", JSON.stringify({
					metadata: { uid: current.metadata.uid, resourceVersion: current.metadata.resourceVersion },
					spec: { template: { metadata: { annotations: { [revisionAnnotation]: consumer.revision } } } },
				})]);
				progress.mutationStatus = "applied";
			}
			kubectl(["-n", namespace, "rollout", "status", `deployment/${consumer.name}`, `--timeout=${timeout}`]);
			const observed = read("deployment", consumer.name);
			assert(observed.metadata.uid === current.metadata.uid && consumerRolledOut(observed, consumer.revision, consumer.replicas),
				"RUNTIME_INPUT_CONSUMER_ROLLOUT_FAILED");
			consumer.observed = observed;
			if (attempt) Object.assign(attempt, { state: "verified", resourceVersion: observed.metadata.resourceVersion });
			assertPublishedSecrets();
		}
		progress.phase = "login";
		assert(files.login && plan.loginCandidate, "RUNTIME_INPUT_LOGIN_REQUIRED");
		const { verifyLoginAfterRollout } = await import("./bootstrap-login.ts");
		await verifyLoginAfterRollout(files.login, sourceSha, plan.origin, plan.loginCandidate, loginTrialTarget);
		progress.phase = "verification";
		assertPublishedSecrets();
		for (const consumer of consumers) {
			const current = read("deployment", consumer.name);
			assert(current.metadata.uid === consumer.current.metadata.uid && (current.spec?.replicas ?? 1) === consumer.replicas && current.spec.template.metadata.annotations?.[revisionAnnotation] === consumer.revision, "RUNTIME_INPUT_REPLICA_DRIFT");
			assert(consumerRolledOut(current, consumer.revision, consumer.replicas), "RUNTIME_INPUT_CONSUMER_ROLLOUT_FAILED");
			if (plan.acs || files.codexTrial) await verifyCodexConsumer(consumer, current, false);
			consumer.observed = current;
		}
	}
	const successors = successor ? secrets.map((secret) => ({
		name: secret.current.metadata.name as string, uid: secret.current.metadata.uid as string, resourceVersion: secret.current.metadata.resourceVersion as string,
		components: consumers.filter((c) => c.secretName === secret.current.metadata.name).map((c) => c.component),
		changedKeys: Object.keys(secret.desired.data).filter((key) => secret.current.data[key] !== secret.desired.data[key]).sort(),
		revision: hash(JSON.stringify(Object.entries(secret.desired.data).sort(([a], [b]) => a.localeCompare(b)))),
		data: secret.desired.data as Record<string, string>,
	})) : undefined;
	if (successors) assert(successors.every((s) => Object.keys(secrets.find((x) => x.current.metadata.name === s.name)!.current.data).sort().join() === Object.keys(s.data).sort().join()), "RUNTIME_INPUT_SECRET_DRIFT");
	return { schemaVersion: 1, kind: "ack-runtime-inputs", status: "passed", mode: apply ? "applied-and-read-back" : successor ? "successor-plan" : "read-only-plan", sourceSha,
		...(successors ? { successor: { schemaVersion: 1, kind: "ack-runtime-input-successors", sourceSha, clusterUid, namespace, namespaceUid: ns.metadata.uid as string, installationId, secrets: successors } } : {}),
		secretCount: secrets.length, changedSecretCount: secrets.filter((s) => s.changed).length,
		consumers: consumers.map((c) => ({ component: c.component, desiredReplicas: c.replicas, declaredReplicas: c.observed.spec?.replicas ?? 1, updatedReplicas: c.observed.status?.updatedReplicas ?? null, availableReplicas: c.observed.status?.availableReplicas ?? null, readyReplicas: c.observed.status?.readyReplicas ?? null })),
		rolloutCount: consumers.filter((c) => c.changed).length, templateCount: adoptionInputs.length, loginVerified: apply, businessVerified: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	let operationStarted = false;
	let appliedResult: Awaited<ReturnType<typeof publishRuntimeInputs>> | undefined;
	try {
		const [mode, bootstrap, templates, capacity, requests, rendered, scope, ...extra] = process.argv.slice(2);
		assert((scope === undefined || scope === "--codex-trial" || scope === "--external-service-trial") && extra.length === 0, "RUNTIME_INPUTS_INVALID");
		const codexTrial = scope === "--codex-trial";
		const externalServiceTrial = scope === "--external-service-trial";
		const { ACK_SOURCE_SHA: source, ACK_KUBECONFIG: kubeconfig, ACK_NAMESPACE: namespace } = process.env;
		assert(["plan", "apply", "successor-plan"].includes(mode) && source && kubeconfig && namespace);
		const successorFile = process.env.ACK_RUNTIME_INPUT_SUCCESSOR_FILE;
		if (mode === "successor-plan") {
			assert(successorFile, "RUNTIME_INPUTS_INVALID");
			let insideGit = false;
			try { insideGit = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dirname(successorFile), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() === "true"; } catch {}
			assert(!insideGit, "RUNTIME_INPUT_FILE_INSIDE_WORKTREE");
		}
		assert((await privateJson(bootstrap)).namespace === namespace);
		const run: Kubectl = (args, input) => execFileSync("kubectl", ["--kubeconfig", kubeconfig, ...args], {
			input, encoding: "utf8", timeout: args.includes("rollout") ? 310_000 : args.includes("exec") ? 60_000 : 30_000,
			maxBuffer: 16 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
		});
		const manifest = await readFile(rendered, "utf8");
		const files = { codexTrial, externalServiceTrial, trustedTrialTarget: process.env.ACK_TRUSTED_TRIAL_TARGET_FILE,
			templateImages: process.env.ACK_TEMPLATE_IMAGE_MANIFEST, bootstrap, templates, capacity, requests,
			login: process.env.ACK_LOGIN_BOOTSTRAP_FILE || undefined, reserves: process.env.ACK_SESSION_RESERVES_FILE || undefined };
		const publish = async () => {
			operationStarted = true;
			return appliedResult = await publishRuntimeInputs(files, manifest, source, run, mode === "apply", undefined, { successor: mode === "successor-plan" });
		};
		if (mode === "apply") {
			assert(process.env.ACK_LOGIN_BOOTSTRAP_FILE, "RUNTIME_INPUT_LOGIN_REQUIRED");
			await publishRuntimeInputs(files, manifest, source, run, false);
		}
		const observed = mode === "apply" ? await observeApiRollout({ ...apiRolloutTools(kubeconfig, namespace, 600_000), sourceSha: source, desiredReplicas: apiReplicaTarget(manifest), timeoutMs: 600_000 }, publish) : null;
		let result: any = observed ? { ...observed.value, apiRollout: observed.receipt } : await publish();
		if (mode === "successor-plan") {
			const { successor: candidate, ...summary } = result;
			assert(candidate, "RUNTIME_INPUTS_INVALID");
			await writeFile(successorFile!, jsonBytes(candidate), { mode: 0o600, flag: "wx" });
			result = { ...summary, successorSha256: hash(jsonBytes(candidate)),
				successorSecrets: candidate.secrets.map(({ data: _data, ...entry }: any) => entry) };
		}
		let reserveConsumersVerified = false;
		if (mode === "apply" && process.env.ACK_SESSION_RESERVES_FILE) {
			const input = await privateJson(bootstrap);
			const expected = await privateJson(process.env.ACK_SESSION_RESERVES_FILE);
			const documents = parseAllDocuments(manifest).map((doc) => doc.toJSON());
			for (const component of ["api", "worker"] as const) {
				const deployment = documents.find((doc) => doc?.kind === "Deployment" && doc.metadata?.name === `agent-infra-${component}`);
				const readConsumer = component === "api" ? readReserveApi : readReserveWorker;
				const actual: ReturnType<typeof readReserveWorker> | ReturnType<typeof readReserveApi> = readConsumer({ ACK_SOURCE_SHA: source, ACK_NAMESPACE: namespace, ACK_KUBECONFIG: kubeconfig }, input, configurationSecret(deployment, component), run);
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
