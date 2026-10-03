import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { compareUpgradePaths } from "./provider-upgrade-guard.mjs";

const hash = char=>`sha256:${char.repeat(64)}`;
const original = {
	provider:"service",providerReleaseId:"service-v1",executorDigest:hash("1"),
	sourceCommit:"fixture",authDigest:hash("2"),deploymentDigest:hash("3"),
	credentialUpgradeBehavior:"DIRECT",
	actions:[{id:"service.read@v1",name:"service.read",authorizationDigest:hash("4")}],
	compatibility:[],
};
const proof = {
	provider:"service",fromReleaseId:"service-v1",toReleaseId:"service-v2",
	fromExecutorDigest:hash("1"),toExecutorDigest:hash("5"),
	rationale:"Reviewed repair",reviewReference:"https://github.com/AgoraIO-Extensions/agent-infra/issues/1232",
};
const replacement = {
	...original,providerReleaseId:"service-v2",executorDigest:hash("5"),
	actions:[{...original.actions[0],id:"service.read@v2"}],
	compatibility:[proof],
};
const snapshot = provider=>({version:1,providers:[provider]});
const plan = strategy=>({version:1,transitions:[{
	provider:proof.provider,fromReleaseId:proof.fromReleaseId,toReleaseId:proof.toReleaseId,
	fromExecutorDigest:proof.fromExecutorDigest,toExecutorDigest:proof.toExecutorDigest,
	strategy,reviewReference:proof.reviewReference,
}]});

test("publication gates the previous formal tag even when connection already contains the candidate", () => {
	const workflow = parse(readFileSync(new URL("../workflows/publish-ghcr.yml", import.meta.url), "utf8"));
	const validation = workflow.jobs["upgrade-validation"];
	const gate = validation.steps.findIndex(step => step.name === "Verify canonical Connection release and upgrade paths");
	assert.ok(gate >= 0 && gate < validation.steps.findIndex(step => step.name === "Run existing-account upgrade regression"));
	assert.deepEqual(workflow.jobs.publish.needs, ["upgrade-validation"]);
	assert.match(workflow.jobs.publish.if, /needs\.upgrade-validation\.result == 'success'/);
	const temp = mkdtempSync(join(tmpdir(), "provider-publish-upgrade-"));
	const candidate = join(temp, "candidate");
	const remote = join(temp, "remote.git");
	const git = (...args) => execFileSync("git", args, {cwd:candidate,encoding:"utf8",stdio:["ignore","pipe","pipe"]});
	const write = (path, value) => {
		const destination = join(candidate, path);
		mkdirSync(dirname(destination), {recursive:true});
		writeFileSync(destination, value);
	};
	const commit = () => {
		git("add", "-A");
		git("-c", "commit.gpgsign=false", "commit", "-m", "fixture");
		git("push", "origin", "connection");
	};
	const run = () => spawnSync("bash", ["-e", "-o", "pipefail", "-c", validation.steps[gate].run], {
		cwd:candidate,encoding:"utf8",
		env:{...process.env,GITHUB_REF_NAME:"connection-v0.0.2",GITHUB_STEP_SUMMARY:join(temp,"summary")},
	});
	try {
		execFileSync("git", ["init", "--bare", remote], {stdio:"ignore"});
		execFileSync("git", ["init", "-b", "connection", candidate], {stdio:"ignore"});
		git("config", "core.hooksPath", join(temp,"no-hooks"));
		git("config", "user.email", "fixture@example.invalid");
		git("config", "user.name", "Fixture");
		git("remote", "add", "origin", remote);
		for (const script of ["connection-release-guard.mjs", "provider-upgrade-guard.mjs"])
			write(`.github/scripts/${script}`,readFileSync(new URL(script,import.meta.url),"utf8"));
		write("migrations/connection/meta/_journal.json",JSON.stringify({entries:[]}));
		write("packages/openconnector-adapter/provider-release-snapshot.json",JSON.stringify(snapshot(original)));
		write("packages/openconnector-adapter/provider-upgrade-plans.json",JSON.stringify({version:1,transitions:[]}));
		commit();
		assert.notEqual(run().status,0,"missing formal baseline must fail closed");
		git("tag","connection-v0.0.1");
		write("packages/openconnector-adapter/provider-release-snapshot.json",JSON.stringify(snapshot(replacement)));
		commit();
		git("tag","connection-v0.0.2");
		const missing = run();
		assert.notEqual(missing.status,0);
		assert.match(missing.stderr,/Missing or stale upgrade path/);
		write("packages/openconnector-adapter/provider-upgrade-plans.json",JSON.stringify(plan("COMPATIBLE_REPAIR")));
		commit();
		const allowed = run();
		assert.equal(allowed.status,0,allowed.stderr);
		assert.match(allowed.stdout,/Upgrade paths verified: 1/);
	} finally {
		rmSync(temp,{recursive:true,force:true});
	}
});

test("unchanged catalogs need no invented migration path",()=>{
	assert.deepEqual(compareUpgradePaths(snapshot(original),snapshot(original),{version:1,transitions:[]}),[]);
});
test("changed releases require a pinned path and runtime compatibility evidence",()=>{
	assert.throws(()=>compareUpgradePaths(snapshot(original),snapshot(replacement),{version:1,transitions:[]}),/Missing or stale/);
	const stale=plan("COMPATIBLE_REPAIR");stale.transitions[0].toExecutorDigest=hash("6");
	assert.throws(()=>compareUpgradePaths(snapshot(original),snapshot(replacement),stale),/Missing or stale/);
	assert.throws(()=>compareUpgradePaths(snapshot(original),snapshot({...replacement,compatibility:[]}),plan("COMPATIBLE_REPAIR")),/no runtime approval evidence/);
	assert.equal(compareUpgradePaths(snapshot(original),snapshot(replacement),plan("COMPATIBLE_REPAIR")).length,1);
});
test("scope/schema/effect or auth/deployment drift requires approval rather than a repair label",()=>{
	for(const changed of [
		{...replacement,authDigest:hash("6")},
		{...replacement,deploymentDigest:hash("6")},
		{...replacement,actions:[{...replacement.actions[0],authorizationDigest:hash("6")}]},
	]) {
		assert.throws(()=>compareUpgradePaths(snapshot(original),snapshot(changed),plan("COMPATIBLE_REPAIR")),/authorization boundary/);
		assert.equal(compareUpgradePaths(snapshot(original),snapshot(changed),plan("REAPPROVAL_REQUIRED")).length,1);
	}
});
test("same-version changes and duplicate or unknown plans fail closed",()=>{
	assert.throws(()=>compareUpgradePaths(snapshot(original),snapshot({...original,executorDigest:hash("5")}),{version:1,transitions:[]}),/Immutable Provider changed/);
	const duplicate=plan("COMPATIBLE_REPAIR");duplicate.transitions.push({...duplicate.transitions[0]});
	assert.throws(()=>compareUpgradePaths(snapshot(original),snapshot(replacement),duplicate),/Duplicate upgrade/);
	assert.throws(()=>compareUpgradePaths(snapshot(original),snapshot(replacement),plan("AUTO_GRANT_ALL")),/Unknown upgrade/);
});
test("additional Actions cannot be claimed as part of the original approved subset",()=>{
	const extra={...replacement,actions:[...replacement.actions,{id:"service.extra@v2",name:"service.extra",authorizationDigest:hash("6")}]};
	assert.equal(compareUpgradePaths(snapshot(original),snapshot(extra),plan("COMPATIBLE_REPAIR")).length,1);
	// This gate proves only the old boundary; runtime maps the original approved subset.
	assert.throws(()=>compareUpgradePaths(snapshot(original),snapshot({...extra,actions:extra.actions.slice(1)}),plan("COMPATIBLE_REPAIR")),/authorization boundary/);
});
