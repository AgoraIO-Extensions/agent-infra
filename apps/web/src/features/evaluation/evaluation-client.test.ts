import { expect, it } from "vitest";
import { createClientConfig } from "../../pilot/generated-client-config.js";
import { createClient } from "../../pilot/generated-v2/client/index.js";
import {
	createEvaluationDatasetV1,
	readEvaluationContentV1,
} from "../../pilot/generated-v2/sdk.gen.js";

it("generated Eval read/write clients select Bearer without a Cookie or ambient browser session", async () => {
	const requests: Request[] = [];
	const client = createClient(
		createClientConfig({
			baseUrl: "https://platform.test",
			auth: "synthetic-eval-material",
			fetch: async (request) => {
				requests.push(request as Request);
				return Response.json({});
			},
		}),
	);
	await createEvaluationDatasetV1({
		client,
		body: { scope: "fixture", name: "fixture" },
		headers: { "Idempotency-Key": "fixture-key" },
	});
	await readEvaluationContentV1({
		client,
		path: {
			datasetId: "11111111-1111-4111-8111-111111111111",
			versionId: "22222222-2222-4222-8222-222222222222",
		},
	});
	expect(requests).toHaveLength(2);
	for (const request of requests) {
		expect(request.headers.get("Authorization")).toBe(
			"Bearer synthetic-eval-material",
		);
		expect(request.headers.has("Cookie")).toBe(false);
		expect(request.credentials).toBe("omit");
	}
	const mixed = await createEvaluationDatasetV1({
		client,
		body: { scope: "fixture", name: "fixture" },
		headers: { Cookie: "session=fixture", "Idempotency-Key": "fixture-key" },
	});
	expect(mixed.error).toBeInstanceOf(TypeError);
	expect(requests).toHaveLength(2);
});
