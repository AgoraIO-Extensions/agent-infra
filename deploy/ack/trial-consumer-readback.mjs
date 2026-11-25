// Executed inside each Ready Pod with its actual configuration module and environment.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { standardTemplateReadinessV1 } from "@agent-infra/model-catalog";

const [component, raw] = process.argv.slice(2);
const expected = JSON.parse(raw);
const context = expected.record.adoption.target;
const candidate = expected.record.candidate;
assert.equal(candidate.templateId, "codex");
assert.equal(expected.profile?.imageDigest, candidate.imageDigest);
const allowUnverified = expected.externalServiceTrial === true;
if (allowUnverified) assert.equal(context.namespace, "agent-infra-ext4425");
const retainedPairs = expected.retainedPairs ?? [];
assert(Array.isArray(retainedPairs));
assert(retainedPairs.every(pair => pair.templateId === "codex" && pair.imageDigest !== candidate.imageDigest && /^sha256:[a-f0-9]{64}$/.test(pair.imageDigest)));
assert.equal(new Set(retainedPairs.map(pair => pair.imageDigest)).size, retainedPairs.length);
if (!allowUnverified) assert.equal(retainedPairs.length, 0);
function selectedBinding(bindings) {
	assert(Array.isArray(bindings));
	if (!allowUnverified) assert.equal(bindings.length, 1);
	else {
		assert(bindings.every(binding => ["codex", "claude", "opencode", "pi"].includes(binding.templateId)));
		if (component === "api") {
			assert(bindings.length > 0 && bindings.length <= 4);
			assert.equal(new Set(bindings.map(binding => binding.templateId)).size, bindings.length);
		} else {
			assert(bindings.length > 0 && bindings.length <= 4 + retainedPairs.length);
			assert.equal(new Set(bindings.map(binding => `${binding.templateId}@${binding.imageDigest}`)).size, bindings.length);
			const others = bindings.filter(binding => binding.templateId !== "codex");
			assert.equal(new Set(others.map(binding => binding.templateId)).size, others.length);
			const codex = bindings.filter(binding => binding.templateId === "codex");
			const allowed = new Set([candidate.imageDigest, ...retainedPairs.map(pair => pair.imageDigest)]);
			assert.equal(codex.length, allowed.size);
			assert(codex.every(binding => allowed.has(binding.imageDigest) && binding.driver === "codex" && binding.protocol === "openai-responses-v1"));
		}
	}
	const selected = bindings.filter(binding => binding.templateId === candidate.templateId && binding.imageDigest === candidate.imageDigest);
	assert.equal(selected.length, 1);
	return selected[0];
}
if (component === "api") {
	const { apiInput } = await import(process.env.PLATFORM_API_CONFIGURATION_MODULE);
	const template = selectedBinding(apiInput.templates);
	for (const unused of apiInput.templates.filter(entry => entry !== template))
		assert.deepEqual(await unused.loadValidation(AbortSignal.timeout(10000)), {});
	const validation = await template.loadValidation(AbortSignal.timeout(10000));
	assert.deepEqual(validation, expected.record);
	assert.deepEqual(template.validationContext, context);
	assert.equal(standardTemplateReadinessV1({
		templateId: template.templateId, imageDigest: template.imageDigest,
		binding: template.modelBinding, configurationRevision: template.configurationRevision,
		validation, validationContext: template.validationContext, now: Date.now(),
	}).state, "ready");
	process.stdout.write("verified");
} else {
	assert.equal(component, "worker");
	const config = new URL("./configuration.mjs", process.env.PLATFORM_WORKER_DEPLOYMENT_MODULE);
	const { workloadInput } = await import(config.href);
	const binding = selectedBinding(workloadInput.templateModelBindings);
	for (const unused of workloadInput.templateModelBindings.filter(entry => entry !== binding)) {
		if (allowUnverified && unused.templateId === "codex") {
			assert(retainedPairs.some(pair => pair.imageDigest === unused.imageDigest));
			continue;
		}
		assert.deepEqual(JSON.parse(await readFile(join(dirname(expected.recordFile), `template-validation-${unused.templateId}.json`), "utf8")), {});
	}
	assert.equal(binding.templateId, candidate.templateId);
	assert.equal(binding.imageDigest, candidate.imageDigest);
	assert.equal(binding.driver, "codex");
	assert.equal(binding.protocol, "openai-responses-v1");
	assert.equal(workloadInput.policy.namespace, context.namespace);
	assert.deepEqual(workloadInput.executionCapacityProfiles, allowUnverified ? expected.profiles : [expected.profile]);
	const validation = JSON.parse(await readFile(expected.recordFile, "utf8"));
	assert.deepEqual(validation, expected.record);
	const {resourceProfileRef, resources, codexSessionExecutor, workspaceSnapshotEgress, storageSize, storageClassName} = workloadInput.policy;
	process.stdout.write(JSON.stringify({resourceProfileRef, resources, codexSessionExecutor, workspaceSnapshotEgress, storageSize, storageClassName}));
}
