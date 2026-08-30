import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const forbiddenImports = [
	"platform-core",
	"platform-store",
	"identity",
	"connection",
	"kubernetes",
	"model-catalog",
	"apps/",
];

describe("agent-runtime dependency direction", () => {
	it("depends only on the wire contract package at runtime", async () => {
		const packageJson = JSON.parse(
			await readFile(new URL("../package.json", import.meta.url), "utf8"),
		) as { dependencies?: Record<string, string> };

		expect(Object.keys(packageJson.dependencies ?? {})).toEqual([
			"@agent-infra/contracts",
		]);
	});

	it("keeps Platform, identity, Connection, and deployment modules out of production imports", async () => {
		const sourceDirectory = new URL("./", import.meta.url);
		const productionSources = (await readdir(sourceDirectory))
			.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
			.sort();
		const source = (
			await Promise.all(
				productionSources.map((name) =>
					readFile(new URL(name, sourceDirectory), "utf8"),
				),
			)
		).join("\n");
		const imports = [
			...source.matchAll(/(?:from\s+|import\s*\()["']([^"']+)/g),
		].map((match) => match[1] ?? "");

		for (const forbidden of forbiddenImports) {
			expect(
				imports.some((specifier) => specifier.includes(forbidden)),
				`forbidden runtime import: ${forbidden}`,
			).toBe(false);
		}
	});
});
