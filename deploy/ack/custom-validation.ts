import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { privateJson } from "./private-input.ts";
import { readAgentBindings } from "./agent-bindings.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export async function customValidationPlan(requestsFile: string, stateDirectory: string, evidenceDirectory: string, sourceSha: string, webConfigs: string[] = []) {
	assert(/^[a-f0-9]{40}$/u.test(sourceSha) && isAbsolute(stateDirectory) && isAbsolute(evidenceDirectory));
	assert(Array.isArray(webConfigs) && webConfigs.length <= 20 && new Set(webConfigs).size === webConfigs.length);
	const requests = await privateJson(requestsFile);
	assert(requests.schemaVersion === 1 && Array.isArray(requests.requests) && requests.requests.length > 0 && requests.requests.length <= 20);
	const bodies = await readAgentBindings(requests, stateDirectory, sourceSha);
	const names = new Set();
	const agentIds = new Set();
	const custom = [];
	for (const request of bodies) {
		assert(/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(request.name) && !names.has(request.name));
		names.add(request.name);
		const body = request.body;
		assert(["standard", "custom"].includes(body.source?.kind));
		if (body.source.kind !== "custom") continue;
		assert(["platform-adapter", "self-managed"].includes(body.source.interactionMode), "CUSTOM_INTERACTION_MODE_INVALID");
		const entry = request.binding;
		assert(entry?.ready === true && typeof entry.agentId === "string" && entry.agentId.length > 0 && !agentIds.has(entry.agentId), "CUSTOM_BINDING_NOT_READY");
		agentIds.add(entry.agentId);
		custom.push({ name: request.name, mode: body.source.interactionMode, agentId: entry.agentId });
	}
	assert(custom.length >= 1, "CUSTOM_REQUESTS_MISSING");
	let platformAdapterCount = 0;
	let selfManagedCount = 0;
	for (const entry of custom) {
		if (entry.mode === "self-managed") { selfManagedCount++; continue; }
		const receipt = await privateJson(join(evidenceDirectory, `template-custom-${entry.name}.json`));
		assert(receipt.result === "passed" && receipt.commit === sourceSha && receipt.worktreeDirty === false && receipt.agentHash === hash(entry.agentId), "CUSTOM_BROWSER_BINDING_INVALID");
		assert(receipt.sessions?.owner === 200 && receipt.sessions.other === 200 && Number.isSafeInteger(receipt.requestedTurnCount) &&
			receipt.requestedTurnCount >= 3 && receipt.completedTurnCount === receipt.requestedTurnCount &&
			Array.isArray(receipt.turns) && receipt.turns.length === receipt.requestedTurnCount, "CUSTOM_BROWSER_INCOMPLETE");
		for (const [index, turn] of receipt.turns.entries()) {
			assert(turn.index === index + 1 && turn.result === "passed" && turn.stage === "completed" && turn.reload === "restored" &&
				[403, 404].includes(turn.crossUserReadStatus) && [403, 404].includes(turn.crossUserSseStatus) &&
				Array.isArray(turn.sse?.observedFrames) && turn.sse.observedFrames.some((f: any) => f.type === "text.delta" && f.textLength > 0) &&
				turn.sse.observedFrames.some((f: any) => f.type === "execution.status" && f.status === "completed"), "CUSTOM_BROWSER_TURN_INVALID");
		}
		platformAdapterCount++;
	}
	if (selfManagedCount > 0 && webConfigs.length === 0) throw new Error("CUSTOM_WEB_PROBES_REQUIRED");
	assert.equal(webConfigs.length, selfManagedCount, "CUSTOM_WEB_PROBE_COUNT_INVALID");
	const boundNames = new Set();
	for (const file of webConfigs) {
		const config = await privateJson(file);
		if (config.requestName !== undefined) {
			assert(config.schemaVersion === 1 && config.sourceSha === sourceSha && !boundNames.has(config.requestName) &&
				custom.some(entry => entry.name === config.requestName && entry.mode === "self-managed"), "CUSTOM_ENTRY_REQUEST_BINDING_INVALID");
			boundNames.add(config.requestName);
		}
	}
	if (boundNames.size > 0) assert.equal(boundNames.size, selfManagedCount, "CUSTOM_ENTRY_BOUND_CONFIGS_REQUIRED");
	return { schemaVersion: 1, kind: "ack-custom-validation-plan", platformAdapterCount, selfManagedCount, webProbeCount: webConfigs.length,
		pass: true, webProbesVerified: false, modelCallsVerified: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const [requests, state, evidence, source] = process.argv.slice(2);
		const configs = (process.env.ACK_CUSTOM_AGENT_CONFIGS ?? "").split("\n").filter(Boolean);
		process.stdout.write(`${JSON.stringify(await customValidationPlan(requests, state, evidence, source, configs))}\n`);
	} catch {
		process.stderr.write("ACK_CUSTOM_VALIDATION_PLAN_INVALID\n");
		process.exitCode = 1;
	}
}
