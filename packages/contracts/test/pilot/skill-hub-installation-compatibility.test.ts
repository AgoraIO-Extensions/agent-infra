import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("publishes the installation paths and strict response schemas", async () => {
	const document = JSON.parse(
		await readFile(
			new URL(
				"../../artifacts/openapi/pilot-browser.v2.openapi.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	expect(document.paths["/api/v2/skills/installations"].post.operationId).toBe(
		"installSkillHubVersionV1",
	);
	expect(
		document.paths["/api/v2/skills/installations/{installationId}"].delete
			.operationId,
	).toBe("uninstallSkillHubInstallationV1");
	for (const name of [
		"SkillHubInstallationCommandV1",
		"SkillHubInstallationV1",
		"SkillHubInstallationResponseV1",
	]) {
		expect(document.components.schemas[name]).toBeDefined();
		expect(document.components.schemas[name].additionalProperties).toBe(false);
	}
});
