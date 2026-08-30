import { describe, expect, it } from "vitest";
import { z } from "zod";

import { secretLifecycleSchemasV1 } from "../../src/workload/index.ts";

describe("Secret lifecycle V1 JSON Schema family", () => {
	it("keeps every public family schema representable as JSON Schema 2020-12", () => {
		const definitions = Object.fromEntries(
			Object.entries(secretLifecycleSchemasV1).map(([name, schema]) => [
				name,
				z.toJSONSchema(schema, {
					io: "input",
					target: "draft-2020-12",
					unrepresentable: "throw",
				}),
			]),
		);

		expect(Object.keys(definitions)).toEqual(
			Object.keys(definitions).toSorted(),
		);
		expect(definitions).toHaveProperty("PlatformSecretRecordV1");
		expect(definitions).toHaveProperty("SecretActivationFenceV1");
		expect(definitions).toHaveProperty("SecretEncryptionKeySetV1");
		expect(definitions).toHaveProperty("SecretKeyRotationV1");
		expect(JSON.stringify(definitions)).not.toMatch(
			/v1beta1|providerSpecific|privateKey|plaintext/,
		);
	});
});
