import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("./compatibility.mjs", import.meta.url));
const fixturePath = (name: string) =>
	fileURLToPath(new URL(`../test/compatibility/${name}.json`, import.meta.url));

function compare(current: string, previous = "base") {
	return spawnSync(
		process.execPath,
		[
			cliPath,
			"--previous",
			fixturePath(previous),
			"--current",
			fixturePath(current),
		],
		{ encoding: "utf8" },
	);
}

describe("contract compatibility command", () => {
	it("accepts additive schemas", () => {
		const result = compare("additive");
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});

	it.each([
		["removed", "removed"],
		["narrowed", "narrowed"],
		["retyped", "retyped"],
	])("rejects %s schema changes", (fixture, reason) => {
		const result = compare(fixture);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(reason);
	});

	it("rejects retyped OpenAPI component schemas", () => {
		const result = compare("openapi-retyped", "openapi-base");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("retyped");
	});

	it("rejects introduced const, enum, union, and reference narrowings", () => {
		const result = compare("advanced-narrowed", "advanced-base");
		expect(result.status).toBe(1);
		for (const keyword of ["const", "enum", "oneOf", "$ref", "type"]) {
			expect(result.stderr).toContain(keyword);
		}
	});

	it("rejects adding an array item constraint", () => {
		const result = compare("advanced-narrowed", "advanced-base");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("narrowed $defs.ArrayV1[] items");
	});

	it("rejects adding numeric and collection constraints", () => {
		const result = compare("advanced-narrowed", "advanced-base");
		expect(result.status).toBe(1);
		for (const keyword of [
			"exclusiveMinimum",
			"exclusiveMaximum",
			"multipleOf",
			"uniqueItems",
		]) {
			expect(result.stderr).toContain(keyword);
		}
	});

	it("rejects adding an additional-property schema", () => {
		const result = compare("advanced-narrowed", "advanced-base");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"narrowed $defs.RecordV1 additionalProperties",
		);
	});

	it("rejects composition, tuple, contains, and property-name narrowings", () => {
		const result = compare("advanced-narrowed", "advanced-base");
		expect(result.status).toBe(1);
		for (const keyword of [
			"allOf",
			"not",
			"prefixItems",
			"contains",
			"minContains",
			"maxContains",
			"propertyNames",
		]) {
			expect(result.stderr).toContain(keyword);
		}
	});

	it("rejects adding an overlapping oneOf option", () => {
		const result = compare("advanced-narrowed", "advanced-base");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("narrowed $defs.ExclusiveChoiceV1 oneOf");
	});

	it("accepts removal of type, const, enum, union, and reference constraints", () => {
		const result = compare("advanced-widened", "advanced-base");
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});
});
