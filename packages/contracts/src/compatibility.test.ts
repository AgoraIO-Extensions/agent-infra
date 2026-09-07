import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("./compatibility.mjs", import.meta.url));
const fixturePath = (name: string) =>
	fileURLToPath(new URL(`../test/compatibility/${name}.json`, import.meta.url));
const pilotBrowserArtifactPath = fileURLToPath(
	new URL(
		"../artifacts/openapi/pilot-browser.v1.openapi.json",
		import.meta.url,
	),
);
const runtimeHostV2ArtifactPath = fileURLToPath(
	new URL("../artifacts/openapi/runtime-host.v2.openapi.json", import.meta.url),
);

function comparePaths(current: string, previous: string) {
	return spawnSync(
		process.execPath,
		[cliPath, "--previous", previous, "--current", current],
		{ encoding: "utf8" },
	);
}

function compare(current: string, previous = "base") {
	return comparePaths(fixturePath(current), fixturePath(previous));
}

describe("contract compatibility command", () => {
	it("tracks every published browser OpenAPI version", async () => {
		const source = await readFile(cliPath, "utf8");
		expect(source).toContain(
			'"packages/contracts/artifacts/openapi/pilot-browser.v1.openapi.json"',
		);
		expect(source).toContain(
			'"packages/contracts/artifacts/openapi/pilot-browser.v2.openapi.json"',
		);
	});

	it("accepts additive schemas and disjoint oneOf literals", () => {
		const result = compare("additive");
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});

	it("accepts only the model-selection fallback OpenAPI addition", () => {
		const result = compare(
			"openapi-component-ref-additive",
			"openapi-component-ref-base",
		);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});

	it("rejects every deviation from the fallback OpenAPI addition", async () => {
		const previous = fixturePath("openapi-component-ref-base");
		const additive = JSON.parse(
			await readFile(fixturePath("openapi-component-ref-additive"), "utf8"),
		);
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-openapi-ref-"),
		);
		const expectRejected = async (name: string, current: unknown) => {
			const path = resolve(directory, `${name}.json`);
			await writeFile(path, JSON.stringify(current), "utf8");
			const result = comparePaths(path, previous);
			expect(result.status, name).toBe(1);
			expect(result.stderr, name).toContain("changed OpenAPI contract");
		};

		try {
			for (const [name, ref] of [
				["alternate", "#/components/schemas/OtherEventV1"],
				["external", "https://example.invalid/FallbackEventV1"],
			] as const) {
				const current = structuredClone(additive);
				current.components.schemas.PersistedConversationEventV1.oneOf[1].$ref =
					ref;
				await expectRejected(name, current);
			}

			const missingRef = structuredClone(additive);
			delete missingRef.components.schemas.PersistedConversationEventV1.oneOf[1]
				.$ref;
			await expectRejected("missing-ref", missingRef);

			const sibling = structuredClone(additive);
			sibling.components.schemas.PersistedConversationEventV1.oneOf[1].description =
				"Ref sibling";
			await expectRejected("sibling", sibling);

			const wrongReason = structuredClone(additive);
			wrongReason.components.schemas.ModelSelectionFallbackEventV1.properties.payload.properties.reason.const =
				"provider_failed";
			await expectRejected("wrong-reason", wrongReason);

			const extraPayload = structuredClone(additive);
			const extra =
				extraPayload.components.schemas.ModelSelectionFallbackEventV1.properties
					.payload;
			extra.properties.credential = { type: "string" };
			extra.required.push("credential");
			await expectRejected("extra-payload", extraPayload);

			const operationChange = structuredClone(additive);
			operationChange.paths["/events"].get.operationId = "streamEventsV2";
			await expectRejected("operation", operationChange);

			const discriminatorOverlap = structuredClone(additive);
			const discriminator =
				discriminatorOverlap.components.schemas.PersistedConversationEventV1
					.oneOf[0].properties.type;
			delete discriminator.const;
			discriminator.enum = ["text.delta", "model.selection.fell_back"];
			await expectRejected("existing-discriminator", discriminatorOverlap);

			const removedRequired = structuredClone(additive);
			removedRequired.components.schemas.PersistedConversationEventV1.oneOf[0].required =
				["type"];
			await expectRejected("existing-required", removedRequired);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("accepts only the agent-summary OpenAPI addition", async () => {
		const current = JSON.parse(
			await readFile(pilotBrowserArtifactPath, "utf8"),
		);
		const options = current.components.schemas.ExecutionProcessSummaryV1.oneOf;
		const summaryIndex = options.findIndex(
			(option: { properties?: { kind?: { const?: string } } }) =>
				option.properties?.kind?.const === "agent_summary",
		);
		expect(summaryIndex).toBeGreaterThanOrEqual(0);
		const previous = structuredClone(current);
		previous.components.schemas.ExecutionProcessSummaryV1.oneOf.splice(
			summaryIndex,
			1,
		);
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-agent-summary-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const expectResult = async (
			name: string,
			candidate: unknown,
			status: number,
		) => {
			const currentPath = resolve(directory, `${name}.json`);
			await Promise.all([
				writeFile(previousPath, JSON.stringify(previous), "utf8"),
				writeFile(currentPath, JSON.stringify(candidate), "utf8"),
			]);
			const result = comparePaths(currentPath, previousPath);
			expect(result.status, name).toBe(status);
			if (status === 0) {
				expect(result.stderr, name).toBe("");
			} else {
				expect(result.stderr, name).toContain("changed OpenAPI contract");
			}
		};

		try {
			await expectResult("additive", current, 0);

			const wrongCategory = structuredClone(current);
			wrongCategory.components.schemas.ExecutionProcessSummaryV1.oneOf[
				summaryIndex
			].properties.category.enum.push("credential");
			await expectResult("wrong-category", wrongCategory, 1);

			const extraField = structuredClone(current);
			extraField.components.schemas.ExecutionProcessSummaryV1.oneOf[
				summaryIndex
			].properties.credential = { type: "string" };
			await expectResult("extra-field", extraField, 1);

			const operationChange = structuredClone(current);
			operationChange.info.title = "changed";
			await expectResult("other-change", operationChange, 1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("accepts only the Runtime status-recovery V2 addition", async () => {
		const current = JSON.parse(
			await readFile(runtimeHostV2ArtifactPath, "utf8"),
		);
		const previous = structuredClone(current);
		delete previous.paths["/internal/runtime/v2/status"];
		delete previous.components.schemas.RuntimeStatusRequestV2;
		delete previous.components.schemas.RuntimeStatusResponseV2;
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-runtime-status-recovery-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await Promise.all([
				writeFile(previousPath, JSON.stringify(previous), "utf8"),
				writeFile(currentPath, JSON.stringify(current), "utf8"),
			]);
			expect(comparePaths(currentPath, previousPath).status).toBe(0);

			const changed = structuredClone(current);
			changed.components.schemas.RuntimeStatusRequestV2.properties.recovery.properties.schemaVersion.const = 2;
			await writeFile(currentPath, JSON.stringify(changed), "utf8");
			expect(comparePaths(currentPath, previousPath).status).toBe(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
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
		expect(result.stderr).toContain("changed OpenAPI contract");
	});

	it.each([
		"openapi-operation-removed",
		"openapi-request-media-removed",
		"openapi-response-removed",
		"openapi-parameter-removed",
		"openapi-required-body-added",
	])("rejects %s HTTP contract changes", (fixture) => {
		const previous =
			fixture.startsWith("openapi-parameter") ||
			fixture === "openapi-required-body-added"
				? "openapi-parameter-base"
				: "openapi-base";
		const result = compare(fixture, previous);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("changed OpenAPI contract");
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
		expect(result.stderr).toContain(
			"narrowed $defs.DiscriminatedChoiceV1 oneOf",
		);
		expect(result.stderr).toContain(
			"narrowed $defs.UntypedDiscriminatedChoiceV1 oneOf",
		);
	});

	it("rejects shortening a closed tuple prefix", () => {
		const result = compare("advanced-narrowed", "advanced-base");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("narrowed $defs.TupleV1[0] prefixItems");
	});

	it("rejects replacing a true schema with false", () => {
		const result = compare("advanced-narrowed", "advanced-base");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("narrowed $defs.BooleanSchemaV1 schema");
	});

	it("rejects constraining a property previously governed by an open object", () => {
		const result = compare("advanced-narrowed", "advanced-base");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("narrowed $defs.OpenObjectV1.foo property");
	});

	it.each(["--previous", "--current"])(
		"rejects an unpaired %s fixture argument",
		(option) => {
			const result = spawnSync(
				process.execPath,
				[cliPath, option, fixturePath("base")],
				{ encoding: "utf8" },
			);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("Usage: compatibility.mjs");
		},
	);

	it("rejects adding a dependent required property", () => {
		const result = compare("advanced-narrowed", "advanced-base");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"narrowed $defs.DependentObjectV1.creditCard dependentRequired billingAddress",
		);
	});

	it("rejects nested definition and pattern-property narrowings", () => {
		const result = compare("advanced-narrowed", "advanced-base");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("retyped $defs.NestedDefsV1.$defs.Value");
		expect(result.stderr).toContain(
			"narrowed $defs.PatternObjectV1.^x patternProperties",
		);
		expect(result.stderr).toContain(
			"retyped $defs.PatternExplicitV1.x patternProperties ^x",
		);
		expect(result.stderr).toContain(
			"removed $defs.RemovedNestedDefV1.$defs.Value",
		);
		expect(result.stderr).toContain(
			"removed $defs.UnusedNestedDefV1.$defs.Value",
		);
		expect(result.stderr).toContain(
			"retyped $defs.PatternToPropertyV1.x property ^x",
		);
	});

	it("fails closed for unsupported evaluation constraints", () => {
		const result = compare("advanced-narrowed", "advanced-base");
		expect(result.status).toBe(1);
		for (const keyword of [
			"dependentSchemas",
			"if",
			"then",
			"else",
			"unevaluatedProperties",
			"unevaluatedItems",
		]) {
			expect(result.stderr).toContain(keyword);
		}
	});

	it("accepts removed constraints and proven one-to-many schema widening", () => {
		const result = compare("advanced-widened", "advanced-base");
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});
});
