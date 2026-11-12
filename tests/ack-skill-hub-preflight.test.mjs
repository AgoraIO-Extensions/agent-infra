import assert from "node:assert/strict";
import test from "node:test";
import { validateSkillHubDeploymentProjection } from "../deploy/ack/skill-hub-preflight.mjs";

const good = {
	enabled: true,
	agentVersion: "skill-hub-v1",
	objectStorage: { enabled: true, endpoint: "namespace-local" },
	api: {
		scanner: {
			enabled: true,
			executable: "/opt/agent-infra/skill-scanner/bin/clamscan-wrapper",
			databaseDirectory: "/opt/agent-infra/skill-scanner/db",
		},
		providerImport: true,
		signerMode: "deployment-stable",
	},
	worker: { skillMaterialization: true, agentVersion: "skill-hub-v1" },
};

test("Skill Hub projection accepts complete deployment-owned wiring", () => {
	assert.deepEqual(validateSkillHubDeploymentProjection(good), {
		status: "passed",
		code: "SKILL_HUB_WIRING_READY",
		agentVersion: "skill-hub-v1",
		objectStorage: "namespace-local",
	});
});

test("Skill Hub projection catches the live unmounted scanner path", () => {
	const live = structuredClone(good);
	live.api.scanner.executable = "/usr/bin/clamscan";
	live.api.scanner.databaseDirectory = "/app/deployment/clamav-db";
	assert.equal(
		validateSkillHubDeploymentProjection(live).code,
		"SKILL_HUB_SCANNER_PATH_UNMOUNTED",
	);
});

test("Skill Hub projection catches missing Worker materialization and unstable signing", () => {
	const live = structuredClone(good);
	live.api.signerMode = "ephemeral-runtime-key";
	assert.equal(
		validateSkillHubDeploymentProjection(live).code,
		"SKILL_HUB_SIGNER_NOT_STABLE",
	);
	live.api.signerMode = "deployment-stable";
	live.worker.skillMaterialization = false;
	assert.equal(
		validateSkillHubDeploymentProjection(live).code,
		"SKILL_HUB_WORKER_MATERIALIZATION_UNAVAILABLE",
	);
});
