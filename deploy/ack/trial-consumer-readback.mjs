// Executed inside each Ready Pod with its actual configuration module and environment.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { standardTemplateReadinessV1 } from "@agent-infra/model-catalog";

const [component, raw] = process.argv.slice(2);
const expected = JSON.parse(raw);
const context = expected.record.adoption.target;
const candidate = expected.record.candidate;
if (component === "api") {
	const { apiInput } = await import(process.env.PLATFORM_API_CONFIGURATION_MODULE);
	assert.equal(apiInput.templates.length, 1);
	const [template] = apiInput.templates;
	const validation = await template.loadValidation(AbortSignal.timeout(10000));
	assert.deepEqual(validation, expected.record);
	assert.deepEqual(template.validationContext, context);
	assert.equal(standardTemplateReadinessV1({
		templateId: template.templateId, imageDigest: template.imageDigest,
		binding: template.modelBinding, configurationRevision: template.configurationRevision,
		validation, validationContext: template.validationContext, now: Date.now(),
	}).state, "ready");
} else {
	assert.equal(component, "worker");
	const config = new URL("./configuration.mjs", process.env.PLATFORM_WORKER_DEPLOYMENT_MODULE);
	const { workloadInput } = await import(config.href);
	assert.equal(workloadInput.templateModelBindings.length, 1);
	const [binding] = workloadInput.templateModelBindings;
	assert.equal(binding.templateId, candidate.templateId);
	assert.equal(binding.imageDigest, candidate.imageDigest);
	assert.equal(binding.driver, "codex");
	assert.equal(binding.protocol, "openai-responses-v1");
	assert.equal(workloadInput.policy.namespace, context.namespace);
	assert.equal(workloadInput.policy.resourceProfileRef, expected.profile.resourceProfileRef);
	assert.deepEqual(workloadInput.policy.resources, expected.resources);
	assert.deepEqual(workloadInput.policy.codexSessionExecutor, expected.executor);
	assert.deepEqual(workloadInput.executionCapacityProfiles, [expected.profile]);
	const validation = JSON.parse(await readFile(expected.recordFile, "utf8"));
	assert.deepEqual(validation, expected.record);
}
process.stdout.write("verified");
