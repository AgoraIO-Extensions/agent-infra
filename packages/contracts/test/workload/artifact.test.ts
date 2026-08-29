import { describe, expect, it } from "vitest";
import { z } from "zod";

import * as workloadContracts from "../../src/workload/index.ts";
import { registryManifestSchemasV1 } from "../../src/workload/index.ts";

describe("Registry and Runtime Manifest V1 JSON Schema family", () => {
	it("keeps every public family schema representable as JSON Schema 2020-12", () => {
		const definitions = Object.fromEntries(
			Object.entries(registryManifestSchemasV1).map(([name, schema]) => [
				name,
				z.toJSONSchema(schema, {
					target: "draft-2020-12",
					unrepresentable: "throw",
				}),
			]),
		);

		expect(Object.keys(definitions)).toEqual(
			Object.keys(definitions).toSorted(),
		);
		expect(definitions).toHaveProperty("RuntimeManifestV1");
		expect(definitions).toHaveProperty("ImageRegistryAdmissionResultV1");
		expect(definitions).toHaveProperty("ImageRegistryAdmissionErrorV1");
		expect(JSON.stringify(definitions)).not.toMatch(
			/v1beta1|cloudProvider|credential|privateKey|plaintext/,
		);
	});

	it("keeps Runtime Manifest branch schemas private to the family composition", () => {
		expect(workloadContracts).not.toHaveProperty(
			"PlatformAdapterRuntimeManifestV1Schema",
		);
		expect(workloadContracts).not.toHaveProperty(
			"SelfManagedRuntimeManifestV1Schema",
		);
		expect(registryManifestSchemasV1).not.toHaveProperty(
			"PlatformAdapterRuntimeManifestV1",
		);
		expect(registryManifestSchemasV1).not.toHaveProperty(
			"SelfManagedRuntimeManifestV1",
		);
	});
});
