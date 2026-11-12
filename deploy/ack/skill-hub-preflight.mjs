#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const error = (code, details = {}) => ({ status: "failed", code, ...details });

/** Validate deployment-owned Skill Hub wiring without reading credentials or touching a cluster. */
export function validateSkillHubDeploymentProjection(value) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return error("SKILL_HUB_PROJECTION_INVALID");
	const { enabled, agentVersion, api, worker, objectStorage } = value;
	if (!enabled) return { status: "disabled", code: "SKILL_HUB_DISABLED" };
	if (typeof agentVersion !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(agentVersion))
		return error("SKILL_HUB_AGENT_VERSION_MISSING");
	if (!objectStorage?.enabled || objectStorage.endpoint !== "namespace-local")
		return error("SKILL_HUB_OBJECT_STORAGE_UNAVAILABLE");
	if (!api?.scanner?.enabled)
		return error("SKILL_HUB_SCANNER_UNAVAILABLE");
	if (api.scanner.executable !== "/opt/agent-infra/skill-scanner/bin/clamscan-wrapper" ||
		api.scanner.databaseDirectory !== "/opt/agent-infra/skill-scanner/db")
		return error("SKILL_HUB_SCANNER_PATH_UNMOUNTED", {
			expected: {
				executable: "/opt/agent-infra/skill-scanner/bin/clamscan-wrapper",
				databaseDirectory: "/opt/agent-infra/skill-scanner/db",
			},
		});
	if (api.providerImport !== true)
		return error("SKILL_HUB_PROVIDER_IMPORT_UNAVAILABLE");
	if (api.signerMode !== "deployment-stable")
		return error("SKILL_HUB_SIGNER_NOT_STABLE");
	if (!worker?.skillMaterialization || worker.agentVersion !== agentVersion)
		return error("SKILL_HUB_WORKER_MATERIALIZATION_UNAVAILABLE");
	return {
		status: "passed",
		code: "SKILL_HUB_WIRING_READY",
		agentVersion,
		objectStorage: objectStorage.endpoint,
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const input = process.argv[2];
	if (!input) throw new Error("Usage: skill-hub-preflight.mjs <projection.json>");
	const result = validateSkillHubDeploymentProjection(JSON.parse(readFileSync(input, "utf8")));
	process.stdout.write(`${JSON.stringify(result)}\n`);
	if (result.status === "failed") process.exitCode = 1;
}
