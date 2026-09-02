import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

describe("platform-core package surface", () => {
	it("separates the production Interface from deterministic test controls", async () => {
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		expect(manifest.dependencies).toBeUndefined();
		expect(manifest.exports).toEqual({
			".": {
				types: "./dist/index.d.mts",
				import: "./dist/index.mjs",
			},
			"./testing": {
				types: "./dist/testing.d.mts",
				import: "./dist/testing.mjs",
			},
		});
		expect(manifest.files).toEqual(["dist"]);

		const surface = await import(
			new URL("../dist/index.mjs", import.meta.url).href
		);
		const declarations = await readFile(
			new URL("../dist/index.d.mts", import.meta.url),
			"utf8",
		);
		expect(declarations).not.toMatch(
			/beginInitialAgentConfigurationAdmissionV1|decodeAgentConfigurationRecordV1|InitialAgentConfigurationAdmissionHandleV1/,
		);
		expect(Object.keys(surface).toSorted()).toEqual([
			"AgentConfigurationError",
			"AgentManagementError",
			"ApplicationFoundationError",
			"ApplicationRevisionError",
			"PlatformIdempotencyError",
			"createAgentConfigurationUseCaseV1",
			"createAgentManagementV1",
			"createApplicationFoundationUseCaseV1",
			"createApplicationRevisionUseCaseV1",
			"parseAgentConfigurationChangesV1",
			"platformIdempotencyV1",
			"snapshotAgentConfigurationWritePlanV1",
			"snapshotAgentManagementWritePlanV1",
			"snapshotApplicationFoundationWritePlanV1",
			"snapshotApplicationRevisionWritePlanV1",
		]);
		const testingSurface = await import(
			new URL("../dist/testing.mjs", import.meta.url).href
		);
		expect(Object.keys(testingSurface).toSorted()).toEqual([
			"FakeAgentConfigurationAdmissionsV1",
			"FakeAgentConfigurationTransactionV1",
			"FakeAgentManagementV1",
			"FakeApplicationFoundationTransactionV1",
			"FakeApplicationRevisionTransactionV1",
			"FakePlatformIdempotencyDatabaseV1",
			"applicationRevisionFailurePoints",
		]);
		expect(
			Object.keys(new testingSurface.FakeAgentManagementV1()).toSorted(),
		).toEqual([
			"executeManagementCommand",
			"recordWorkloadObservation",
			"resolveAgentAccess",
		]);
		const managementSource = await readFile(
			new URL("./agent-management.ts", import.meta.url),
			"utf8",
		);
		expect(managementSource).not.toContain("agent-management-access-policy");
		expect(surface).not.toHaveProperty("decideAgentAccessUpdatePolicy");
		expect(
			Object.keys(surface.createApplicationFoundationUseCaseV1({})),
		).toEqual(["submit"]);
		expect(Object.keys(surface.createApplicationRevisionUseCaseV1({}))).toEqual(
			["revise"],
		);

		const pack = JSON.parse(
			execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
				cwd: packageRoot,
				encoding: "utf8",
			}),
		)[0];
		const packedFiles = pack.files.map((file: { path: string }) => file.path);
		expect(packedFiles).toEqual(
			expect.arrayContaining([
				"dist/index.d.mts",
				"dist/index.mjs",
				"dist/testing.d.mts",
				"dist/testing.mjs",
			]),
		);
		expect(
			packedFiles.some((path: string) =>
				/conformance|schema|postgres|drizzle|\.test\./.test(path),
			),
		).toBe(false);
	});
});
