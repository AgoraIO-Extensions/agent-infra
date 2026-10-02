import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const snapshotPath = "packages/openconnector-adapter/provider-release-snapshot.json";
export const planPath = "packages/openconnector-adapter/provider-upgrade-plans.json";
const bootstrapPath = ".github/connection-upgrade-bootstrap.json";
const bootstrapCommit = "445c36c95342e6ba6253106876edf06d614f5df6";
const bootstrapHash = "11c1f4ba3a007f4baadaeb737c4e307d62d7e1bfa5810c4918eb4bff9b49eef5";
const hashPattern = /^sha256:[a-f0-9]{64}$/;
const strategies = new Set(["COMPATIBLE_REPAIR", "REAPPROVAL_REQUIRED", "REAUTHORIZATION_REQUIRED"]);
const git = (...args)=>execFileSync("git",args,{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
const read = (ref,path)=>JSON.parse(git("show",`${ref}:${path}`));
const exists = (ref,path)=>Boolean(git("ls-tree","--name-only",ref,"--",path));

function keys(value,expected,label) {
	if (!value || Array.isArray(value) || typeof value!=="object" ||
		Object.keys(value).sort().join(",")!==[...expected].sort().join(","))
		throw new Error(`Invalid ${label} shape`);
}
function text(value,label) {
	if(typeof value!=="string" || !value.trim() || value.length>2048)
		throw new Error(`Invalid ${label}`);
}
function pin(value,label) {
	if(typeof value!=="string" || !hashPattern.test(value))
		throw new Error(`Invalid ${label} digest`);
}
export function validateSnapshot(snapshot) {
	keys(snapshot,["version","providers"],"release snapshot");
	if(snapshot.version!==1 || !Array.isArray(snapshot.providers) || snapshot.providers.length>100)
		throw new Error("Unsupported release snapshot");
	const providers = new Map();
	for(const provider of snapshot.providers) {
		keys(provider,["provider","providerReleaseId","executorDigest","sourceCommit","credentialUpgradeBehavior","authDigest","deploymentDigest","actions","compatibility"],"Provider snapshot");
		if(!["DIRECT","REAUTHORIZE"].includes(provider.credentialUpgradeBehavior)) throw new Error("Invalid credential upgrade behavior");
		for(const field of ["provider","providerReleaseId","sourceCommit"]) text(provider[field],field);
		for(const field of ["executorDigest","authDigest","deploymentDigest"]) pin(provider[field],field);
		if(providers.has(provider.provider)) throw new Error("Duplicate snapshot Provider");
		if(!Array.isArray(provider.actions) || provider.actions.length===0 || provider.actions.length>1000 ||
			!Array.isArray(provider.compatibility) || provider.compatibility.length>100)
			throw new Error("Invalid Provider actions or compatibility");
		const names = new Set(), ids = new Set();
		for(const action of provider.actions) {
			keys(action,["id","name","authorizationDigest"],"Action snapshot");
			text(action.id,"Action id"); text(action.name,"Action name"); pin(action.authorizationDigest,"Action");
			if(names.has(action.name) || ids.has(action.id)) throw new Error("Duplicate snapshot Action");
			names.add(action.name);ids.add(action.id);
		}
		for(const proof of provider.compatibility) {
			keys(proof,["provider","fromReleaseId","toReleaseId","fromExecutorDigest","toExecutorDigest","rationale","reviewReference"],"compatibility evidence");
			for(const field of ["provider","fromReleaseId","toReleaseId","rationale","reviewReference"]) text(proof[field],field);
			pin(proof.fromExecutorDigest,"source executor");pin(proof.toExecutorDigest,"target executor");
		}
		providers.set(provider.provider,provider);
	}
	return providers;
}
function immutable(provider) {
	const { compatibility, ...record } = provider;
	return JSON.stringify(record);
}
export function compareUpgradePaths(beforeSnapshot, afterSnapshot, manifest) {
	const before = validateSnapshot(beforeSnapshot), after = validateSnapshot(afterSnapshot);
	keys(manifest,["version","transitions"],"upgrade manifest");
	if(manifest.version!==1 || !Array.isArray(manifest.transitions) || manifest.transitions.length>1000)
		throw new Error("Unsupported upgrade manifest");
	const declarations = new Map();
	for(const plan of manifest.transitions) {
		keys(plan,["provider","fromReleaseId","toReleaseId","fromExecutorDigest","toExecutorDigest","strategy","reviewReference"],"upgrade declaration");
		for(const field of ["provider","fromReleaseId","toReleaseId","reviewReference"]) text(plan[field],field);
		pin(plan.fromExecutorDigest,"source");pin(plan.toExecutorDigest,"target");
		if(!strategies.has(plan.strategy)) throw new Error("Unknown upgrade strategy");
		const key = JSON.stringify([plan.provider,plan.fromReleaseId,plan.toReleaseId]);
		if(declarations.has(key)) throw new Error("Duplicate upgrade declaration");
		declarations.set(key,plan);
	}
	const transitions = [];
	for(const [provider,old] of before) {
		const next = after.get(provider);
		if(!next) throw new Error(`Runtime Provider removed: ${provider}`);
		if(old.providerReleaseId===next.providerReleaseId) {
			if(immutable(old)!==immutable(next)) throw new Error(`Immutable Provider changed: ${provider}`);
			continue;
		}
		const plan = declarations.get(JSON.stringify([provider,old.providerReleaseId,next.providerReleaseId]));
		if(!plan || plan.fromExecutorDigest!==old.executorDigest || plan.toExecutorDigest!==next.executorDigest)
			throw new Error(`Missing or stale upgrade path: ${provider} ${old.providerReleaseId} -> ${next.providerReleaseId}`);
		if(plan.strategy==="COMPATIBLE_REPAIR" || plan.strategy==="REAUTHORIZATION_REQUIRED") {
			if ((plan.strategy==="COMPATIBLE_REPAIR" && next.credentialUpgradeBehavior!=="DIRECT") ||
				(plan.strategy==="REAUTHORIZATION_REQUIRED" && next.credentialUpgradeBehavior!=="REAUTHORIZE"))
				throw new Error(`Upgrade path disagrees with runtime credential behavior: ${provider}`);
			const actions = new Map(next.actions.map(action=>[action.name,action]));
			if(old.authDigest!==next.authDigest || old.deploymentDigest!==next.deploymentDigest ||
				old.actions.some(action=>actions.get(action.name)?.authorizationDigest!==action.authorizationDigest))
				throw new Error(`Compatible upgrade changes an authorization boundary: ${provider}`);
			if(old.executorDigest!==next.executorDigest && !next.compatibility.some(proof=>
				proof.provider===provider && proof.fromReleaseId===old.providerReleaseId &&
				proof.toReleaseId===next.providerReleaseId && proof.fromExecutorDigest===old.executorDigest &&
				proof.toExecutorDigest===next.executorDigest))
				throw new Error(`Compatible upgrade has no runtime approval evidence: ${provider}`);
		}
		transitions.push(plan);
	}
	return transitions;
}
export function readUpgradeSnapshot(ref) {
	if(exists(ref,snapshotPath)) return read(ref,snapshotPath);
	if(git("rev-parse",ref)!==bootstrapCommit) throw new Error(`Missing upgrade baseline snapshot: ${ref}`);
	const raw = git("show",`HEAD:${bootstrapPath}`)+"\n";
	if(createHash("sha256").update(raw).digest("hex")!==bootstrapHash)
		throw new Error("Upgrade bootstrap is not the reviewed frozen production baseline");
	const bootstrap = JSON.parse(raw);
	if(bootstrap.commit!==bootstrapCommit) throw new Error("Upgrade bootstrap commit mismatch");
	return bootstrap.snapshot;
}
export function verifyUpgradePaths(baselineRef,candidateRef="HEAD") {
	return compareUpgradePaths(readUpgradeSnapshot(baselineRef),readUpgradeSnapshot(candidateRef),read(candidateRef,planPath));
}
