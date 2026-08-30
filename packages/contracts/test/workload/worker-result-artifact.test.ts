import { describe, expect, it } from "vitest";
import { z } from "zod";

import { workerResultSchemasV1 } from "../../src/workload/index.ts";

describe("Worker result V1 JSON Schema family", () => {
	it("keeps every public family schema representable as JSON Schema 2020-12", () => {
		const definitions = Object.fromEntries(
			Object.entries(workerResultSchemasV1).map(([name, schema]) => [
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
		expect(definitions).toHaveProperty("WorkerWorkloadExpectedRevisionV1");
		expect(definitions).toHaveProperty("WorkerWorkloadResultV1");
		expect(definitions).toHaveProperty("WorkerWorkloadErrorV1");
		expect(JSON.stringify(definitions)).not.toMatch(
			/providerResponse|credential|privateKey|plaintext/,
		);
	});
});
