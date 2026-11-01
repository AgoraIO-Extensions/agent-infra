import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

type Json = Record<string, any>;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const readJson = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const standard = new Set(["codex", "claude", "opencode", "pi"]);

function quantity(value: string, unit: "cpu" | "memory") {
	const match = /^(\d+(?:\.\d+)?)(m|Ki|Mi|Gi)?$/u.exec(value);
	assert(match, "RESERVE_PLAN_RESOURCE_INVALID");
	const number = Number(match[1]);
	const suffix = match[2] ?? "";
	if (unit === "cpu") return Math.round(number * (suffix === "m" ? 1 : 1000));
	const multiplier = suffix === "Ki" ? 1024 : suffix === "Mi" ? 1024 ** 2 : suffix === "Gi" ? 1024 ** 3 : 1;
	return Math.round(number * multiplier);
}

export async function bindSessionReserves(planFile: string, stateFile: string, templatesFile: string, capacityFile: string, profilesFile: string, sourceSha: string) {
	const plan = await readJson(planFile);
	const state = await readJson(stateFile);
	const templates = await readJson(templatesFile);
	const capacity = await readJson(capacityFile);
	const profilesDocument = await readJson(profilesFile);
	assert(plan.schemaVersion === 1 && plan.sourceSha === sourceSha && plan.enabled === false, "RESERVE_PLAN_INVALID");
	assert(state.schemaVersion === 1 && state.sourceSha === sourceSha && state.agents, "RESERVE_BINDINGS_INVALID");
	assert(templates.sourceSha === sourceSha && Array.isArray(templates.templates), "RESERVE_TEMPLATES_INVALID");
	assert(capacity.sourceSha === sourceSha && Array.isArray(profilesDocument.profiles), "RESERVE_CAPACITY_INVALID");
	const profile = capacity.resources;
	const resourceConfigurationHash = hash(JSON.stringify({ resourceProfileRef: capacity.resourceProfileRef, requests: profile.requests, limits: profile.limits }));
	const cost = plan.resourceCosts.find((entry: Json) => entry.resourceConfigurationHash === resourceConfigurationHash) ?? plan.resourceCosts[0];
	assert(cost?.resourceConfigurationHash === resourceConfigurationHash, "RESERVE_PLAN_RESOURCE_HASH_INVALID");
	const entries = [];
	for (const templateId of ["codex", "claude", "opencode", "pi"]) {
		assert(standard.has(templateId));
		const binding = state.agents[templateId];
		assert(binding?.ready === true && typeof binding.agentId === "string" && binding.agentId.length > 0, "RESERVE_AGENT_NOT_READY");
		const template = templates.templates.find((entry: Json) => entry.templateId === templateId);
		assert(template?.imageDigest, "RESERVE_TEMPLATE_MISSING");
		const approved = profilesDocument.profiles.find((entry: Json) => entry.imageDigest === template.imageDigest && entry.resourceProfileRef === capacity.resourceProfileRef && entry.resourceConfigurationHash === resourceConfigurationHash);
		assert(approved?.conformanceEvidenceHash, "RESERVE_CAPACITY_PROFILE_MISSING");
		entries.push({
			agentId: binding.agentId,
			templateId,
			imageDigest: template.imageDigest,
			resourceConfigurationHash,
			resources: cost.resources,
			storageConfigurationVersion: `ack-storage-${sourceSha.slice(0, 12)}`,
			networkPolicyVersion: `ack-network-${sourceSha.slice(0, 12)}`,
			signingConfigurationVersion: `ack-signing-${sourceSha.slice(0, 12)}`,
			transportConfigurationVersion: `ack-transport-${sourceSha.slice(0, 12)}`,
			connectionConfigurationVersion: `ack-connection-${sourceSha.slice(0, 12)}`,
			minimum: 1,
			maximum: 1,
		});
	}
	const candidate = {
		...plan,
		sourceSha,
		enabled: true,
		revision: plan.revision + 1,
		maximumReserves: Math.min(plan.maximumReserves || entries.length, entries.length),
		profiles: entries,
	};
	assert(candidate.maximumReserves >= entries.length, "RESERVE_PLAN_MAXIMUM_TOO_SMALL");
	const temporary = `${planFile}.bound-${process.pid}`;
	await writeFile(temporary, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	try { await rename(temporary, planFile); } finally { await unlink(temporary).catch(() => undefined); }
	return { sourceSha, revision: candidate.revision, profileCount: entries.length, configHash: hash(JSON.stringify(candidate)), agentHashes: entries.map((entry) => hash(entry.agentId)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const [plan, state, templates, capacity, profiles, source] = process.argv.slice(2);
		assert(plan && state && templates && capacity && profiles && /^[a-f0-9]{40}$/u.test(source));
		process.stdout.write(`${JSON.stringify(await bindSessionReserves(plan, state, templates, capacity, profiles, source))}\n`);
	} catch { process.stderr.write("ACK_SESSION_RESERVE_BIND_FAILED\n"); process.exitCode = 1; }
}
