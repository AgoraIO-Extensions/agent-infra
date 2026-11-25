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
const allowUnverified = expected.externalServiceTrial === true;
if (allowUnverified) assert.equal(context.namespace, "agent-infra-ext4425");
function selectedBinding(bindings) {
	assert(Array.isArray(bindings));
	if (!allowUnverified) assert.equal(bindings.length, 1);
	else {
		assert(bindings.length > 0 && bindings.length <= 4);
		assert.equal(new Set(bindings.map(binding => binding.templateId)).size, bindings.length);
		assert(bindings.every(binding => ["codex", "claude", "opencode", "pi"].includes(binding.templateId)));
	}
	const selected = bindings.filter(binding => binding.templateId === candidate.templateId);
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
	for (const unused of workloadInput.templateModelBindings.filter(entry => entry !== binding))
		assert.deepEqual(JSON.parse(await readFile(join(dirname(expected.recordFile), `template-validation-${unused.templateId}.json`), "utf8")), {});
	assert.equal(binding.templateId, candidate.templateId);
	assert.equal(binding.imageDigest, candidate.imageDigest);
	assert.equal(binding.driver, "codex");
	assert.equal(binding.protocol, "openai-responses-v1");
	assert.equal(workloadInput.policy.namespace, context.namespace);
	assert.deepEqual(workloadInput.executionCapacityProfiles, [expected.profile]);
	const validation = JSON.parse(await readFile(expected.recordFile, "utf8"));
	assert.deepEqual(validation, expected.record);
	const {resourceProfileRef, resources, codexSessionExecutor, workspaceSnapshotEgress, storageSize, storageClassName} = workloadInput.policy;
	process.stdout.write(JSON.stringify({resourceProfileRef, sessionRuntimePlacement: process.env.AGENT_INFRA_SESSION_RUNTIME_PLACEMENT === undefined ? undefined : JSON.parse(process.env.AGENT_INFRA_SESSION_RUNTIME_PLACEMENT), resources, codexSessionExecutor, workspaceSnapshotEgress, storageSize, storageClassName}));
}
