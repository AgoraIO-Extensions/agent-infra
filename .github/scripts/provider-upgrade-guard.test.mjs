import assert from "node:assert/strict";
import test from "node:test";
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
