import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("./client-smoke.mjs", import.meta.url));

describe("OpenAPI browser client smoke", () => {
	it("generates and compiles from OpenAPI without publishing test output", () => {
		const result = spawnSync(process.execPath, [cliPath], { encoding: "utf8" });
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("client.gen.ts");
	});
});
