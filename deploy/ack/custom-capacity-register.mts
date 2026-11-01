import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { capacityProfile, CUSTOM_CAPACITY_SCOPE, customCapacityJobDefinitionHash, evidenceBytes, sha256, validateCustomCapacityJob } from "./custom-capacity-inputs.mts";
import { privateBytes, privateJson } from "./private-input.ts";
import { validateCapacityBindings } from "./workload-capacity.ts";

type Inputs = { jobFile: string; capacityFile: string; requestsFile: string; sourceSha: string; kubeconfig: string; namespace: string };
const exists = async (file: string) => lstat(file).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });

async function load(input: Inputs) {
	const jobBytes = await privateBytes(input.jobFile);
	const job = validateCustomCapacityJob(JSON.parse(jobBytes.toString("utf8")));
	assert(job.sourceCommit === input.sourceSha && job.kubeconfig === input.kubeconfig && job.namespace === input.namespace, "CUSTOM_CAPACITY_TARGET_MISMATCH");
	const capacityBytes = await privateBytes(input.capacityFile);
	const capacity = JSON.parse(capacityBytes.toString("utf8"));
	const requests = await privateJson(input.requestsFile);
	assert(capacity.schemaVersion === 1 && capacity.sourceSha === input.sourceSha && requests.schemaVersion === 1 && Array.isArray(requests.requests), "CUSTOM_CAPACITY_SOURCE_MISMATCH");
	assert(Array.isArray(capacity.evidence) && capacity.evidence.length <= 64 && new Set(capacity.evidence.map((e: any) => e.imageDigest)).size === capacity.evidence.length, "CUSTOM_CAPACITY_EVIDENCE_AMBIGUOUS");
	const profilesFile = capacity.candidateProfilesFile ?? capacity.profilesFile;
	const profilesBytes = await privateBytes(profilesFile);
	const profiles = JSON.parse(profilesBytes.toString("utf8"));
	assert(profiles.schemaVersion === 1 && Array.isArray(profiles.profiles) && profiles.profiles.length <= 64, "CUSTOM_CAPACITY_PROFILES_INVALID");
	assert(capacity.resourceProfileRef === job.resourceProfileRef, "CUSTOM_CAPACITY_POLICY_MISMATCH");
	assert.deepEqual(capacity.resources, job.resources, "CUSTOM_CAPACITY_POLICY_MISMATCH");
	assert(![input.capacityFile, input.jobFile, input.requestsFile, job.customEnvironmentFile, job.kubeconfig, job.childManifestFile, job.imageConfigFile, job.parentManifestFile, job.recipeFile].includes(profilesFile), "CUSTOM_CAPACITY_PATH_CONFLICT");
	for (const file of [input.capacityFile, profilesFile]) {
		let insideGit = false;
		try { insideGit = execFileSync("git", ["-C", dirname(file), "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim() === "true"; } catch {}
		assert(!insideGit, "CUSTOM_CAPACITY_INPUT_IN_GIT");
	}
	const bodies = await Promise.all(requests.requests.map((request: any) => privateJson(request.bodyFile)));
	const selected = bodies.filter((body: any) => body.source?.kind === "custom" && body.source.interactionMode === "platform-adapter" && body.source.imageReference === job.imageReference);
	assert(selected.length > 0, "CUSTOM_CAPACITY_REQUEST_MISSING");
	return { job, jobBytes, capacity, capacityBytes, profilesFile, profiles, profilesBytes, selected };
}

async function verifyReceipt(state: Awaited<ReturnType<typeof load>>, bytes: Buffer, profile: any) {
	const receipt = JSON.parse(bytes.toString("utf8"));
	const { job, capacity, selected } = state;
	assert(receipt.scope === CUSTOM_CAPACITY_SCOPE && receipt.sourceCommit === job.sourceCommit && receipt.source?.applicationSource === job.sourceCommit && /^[a-f0-9]{64}$/u.test(receipt.source.jobSha256) && receipt.source.jobDefinitionSha256 === customCapacityJobDefinitionHash(job) && receipt.cleanup?.status === "cleaned" && receipt.runtimeModuleSha256 === job.runtimeModuleSha256 && receipt.modelConfigurationSha256 === job.modelConfigurationSha256 && receipt.recipeSha256 === job.recipeSha256 && receipt.nativeModelId === job.expectedModelId && receipt.customEnvironmentSha256 === sha256(await privateBytes(job.customEnvironmentFile)) && receipt.kubeconfigSha256 === sha256(await privateBytes(job.kubeconfig)) && receipt.businessVerified === false, "CUSTOM_CAPACITY_RECEIPT_BINDING_MISMATCH");
	assert.deepEqual(profile, capacityProfile(job, bytes), "CUSTOM_CAPACITY_PROFILE_MISMATCH");
	validateCapacityBindings(selected, [], capacity, [profile], new Map([[job.imageDigest, bytes]]));
}

async function existing(state: Awaited<ReturnType<typeof load>>) {
	const { job, capacity, profiles } = state;
	const entries = capacity.evidence.filter((e: any) => e.imageDigest === job.imageDigest);
	const matches = profiles.profiles.filter((p: any) => p.imageDigest === job.imageDigest);
	assert(entries.length <= 1 && matches.length <= 1, "CUSTOM_CAPACITY_BINDING_AMBIGUOUS");
	if (!entries.length) return false;
	assert(matches.length === 1, "CUSTOM_CAPACITY_PROFILE_MISSING");
	await verifyReceipt(state, await privateBytes(entries[0].file), matches[0]);
	return true;
}

async function replace(file: string, before: Buffer, after: Buffer) {
	assert((await privateBytes(file)).equals(before), "CUSTOM_CAPACITY_INPUT_DRIFT");
	if (before.equals(after)) return;
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, after, { mode: 0o600, flag: "wx" });
		assert((await privateBytes(file)).equals(before), "CUSTOM_CAPACITY_INPUT_DRIFT");
		await rename(temporary, file);
	} finally { await unlink(temporary).catch(() => {}); }
}

/** Local registration only. runtime-inputs owns publication and mounted Worker admission. */
export async function registerCustomCapacity(input: Inputs) {
	const lock = `${input.capacityFile}.custom-capacity-lock`;
	const handle = await open(lock, "wx", 0o600).catch(() => { throw new Error("CUSTOM_CAPACITY_REGISTRATION_LOCKED"); });
	try {
		const state = await load(input);
		if (await existing(state)) return { status: "reused", businessVerified: false };
		const directory = join(state.job.outputDirectory, "measurement");
		assert(!await exists(join(directory, "failure.json")), "CUSTOM_CAPACITY_RECOVERY_REQUIRED");
		const receiptFile = join(directory, "runtime-capacity.receipt.json");
		const bytes = await privateBytes(receiptFile);
		const measured = await privateJson(join(directory, "capacity-profile.json"));
		assert(measured.schemaVersion === 1 && measured.profiles?.length === 1, "CUSTOM_CAPACITY_PROFILE_INVALID");
		const profile = measured.profiles[0];
		await verifyReceipt(state, bytes, profile);
		const prior = state.profiles.profiles.filter((p: any) => p.imageDigest === state.job.imageDigest);
		assert(prior.length <= 1, "CUSTOM_CAPACITY_BINDING_AMBIGUOUS");
		// A profile-only partial write can be completed, but never replaced with different evidence.
		if (prior.length) assert.deepEqual(prior[0], profile, "CUSTOM_CAPACITY_EXISTING_PROFILE_CONFLICT");
		const profiles = prior.length ? state.profiles : { ...state.profiles, profiles: [...state.profiles.profiles, profile] };
		const capacity = { ...state.capacity, evidence: [...state.capacity.evidence, { imageDigest: state.job.imageDigest, file: receiptFile }] };
		assert(profiles.profiles.length <= 64 && capacity.evidence.length <= 64, "CUSTOM_CAPACITY_INPUT_LIMIT");
		assert((await privateBytes(input.jobFile)).equals(state.jobBytes), "CUSTOM_CAPACITY_JOB_DRIFT");
		assert((await privateBytes(input.capacityFile)).equals(state.capacityBytes), "CUSTOM_CAPACITY_INPUT_DRIFT");
		await replace(state.profilesFile, state.profilesBytes, prior.length ? state.profilesBytes : evidenceBytes(profiles));
		// Publish the evidence reference last; interrupted writes cannot pass the existing gate.
		await replace(input.capacityFile, state.capacityBytes, evidenceBytes(capacity));
		assert((await privateBytes(receiptFile)).equals(bytes), "CUSTOM_CAPACITY_RECEIPT_DRIFT");
		assert(await existing(await load(input)), "CUSTOM_CAPACITY_REGISTRATION_READBACK_FAILED");
		return { status: "registered", evidenceSha256: profile.conformanceEvidenceHash, businessVerified: false };
	} finally { await handle.close(); await unlink(lock); }
}

export async function runCustomCapacityPreflight(input: Inputs, measure?: (jobFile: string) => Promise<unknown>) {
	const state = await load(input);
	if (await existing(state)) return { status: "reused", businessVerified: false };
	const directory = join(state.job.outputDirectory, "measurement");
	if (await exists(directory)) {
		assert(!await exists(join(directory, "failure.json")) && await exists(join(directory, "runtime-capacity.receipt.json")) && await exists(join(directory, "capacity-profile.json")), "CUSTOM_CAPACITY_RECOVERY_REQUIRED");
	} else {
		assert(!state.profiles.profiles.some((p: any) => p.imageDigest === state.job.imageDigest), "CUSTOM_CAPACITY_RECOVERY_REQUIRED");
		const execute = measure ?? (await import("./custom-model-preflight.mts")).executeCustomCapacityJob;
		await execute(input.jobFile);
	}
	assert((await privateBytes(input.jobFile)).equals(state.jobBytes), "CUSTOM_CAPACITY_JOB_DRIFT");
	assert((await privateBytes(input.capacityFile)).equals(state.capacityBytes) && (await privateBytes(state.profilesFile)).equals(state.profilesBytes), "CUSTOM_CAPACITY_INPUT_DRIFT");
	return registerCustomCapacity(input);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		assert(process.argv.length === 8, "CUSTOM_CAPACITY_ARGUMENTS_INVALID");
		const [jobFile, capacityFile, requestsFile, sourceSha, kubeconfig, namespace] = process.argv.slice(2);
		assert(jobFile && capacityFile && requestsFile && sourceSha && kubeconfig && namespace, "CUSTOM_CAPACITY_ARGUMENTS_INVALID");
		process.stdout.write(`${JSON.stringify(await runCustomCapacityPreflight({ jobFile, capacityFile, requestsFile, sourceSha, kubeconfig, namespace }))}\n`);
	} catch (error) {
		const code = error instanceof Error && /^CUSTOM_CAPACITY_[A-Z_]+$/u.test(error.message) ? error.message : "CUSTOM_CAPACITY_REGISTRATION_FAILED";
		process.stdout.write(`${JSON.stringify({ status: "failed", code, businessVerified: false })}\n`);
		process.exitCode = 1;
	}
}
