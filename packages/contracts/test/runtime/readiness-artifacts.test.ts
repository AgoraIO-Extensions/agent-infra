import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
	WorkloadReadinessGrantClaimsV1Schema,
	WorkloadReadinessRequestV1Schema,
} from "../../src/runtime/index.js";

const binding = {
	schemaVersion: 1,
	workerId: "worker-a",
	agentId: "agent-a",
	workloadRevision: 2,
	fence: 4,
	imageDigest: `sha256:${"a".repeat(64)}`,
	requestId: "request-a",
	traceId: "trace-a",
};
const request = {
	...binding,
	grant: {
		schemaVersion: 1,
		format: "workload-readiness-jws",
		token: "header.payload.signature",
	},
};
const claims = {
	...binding,
	issuer: "platform",
	audience: "runtime_host_readiness",
	purpose: "readiness.read",
	grantId: "grant-a",
	issuedAt: 1_000,
	expiresAt: 31_000,
};
async function artifact(path: string) {
	return JSON.parse(
		await readFile(new URL(`../../artifacts/${path}`, import.meta.url), "utf8"),
	);
}

describe("published Workload readiness contract", () => {
	it("publishes a separate authenticated operation without extending business endpoints", async () => {
		const readiness = await artifact(
			"openapi/runtime-readiness.v1.openapi.json",
		);
		expect(readiness.openapi).toBe("3.1.0");
		expect(Object.keys(readiness.paths)).toEqual([
			"/internal/runtime/v1/readiness",
		]);
		expect(readiness.security).toEqual([{ RuntimeServiceBearer: [] }]);
		expect(readiness.components.securitySchemes.RuntimeServiceBearer).toEqual({
			type: "http",
			scheme: "bearer",
		});
		const operation = readiness.paths["/internal/runtime/v1/readiness"].post;
		expect(operation.operationId).toBe("readWorkloadReadinessV1");
		expect(operation.requestBody.content["application/json"].schema).toEqual({
			$ref: "#/components/schemas/WorkloadReadinessRequestV1",
		});
		expect(
			operation.responses["200"].content["application/json"].schema,
		).toEqual({
			$ref: "#/components/schemas/WorkloadReadinessResponseV1",
		});
		for (const version of [1, 2]) {
			const business = await artifact(
				`openapi/runtime-host.v${version}.openapi.json`,
			);
			expect(business.paths).not.toHaveProperty(
				"/internal/runtime/v1/readiness",
			);
			expect(JSON.stringify(business)).not.toContain("WorkloadReadiness");
		}
	});

	it("keeps generated and source request/claims validators strict at the business boundary", async () => {
		const document = await artifact(
			"json-schema/runtime-readiness.v1.schema.json",
		);
		const ajv = new Ajv2020({ strict: true });
		ajv.addSchema(document);
		for (const [name, source, valid] of [
			["WorkloadReadinessRequestV1", WorkloadReadinessRequestV1Schema, request],
			[
				"WorkloadReadinessGrantClaimsV1",
				WorkloadReadinessGrantClaimsV1Schema,
				claims,
			],
		] as const) {
			const validate = ajv.compile({ $ref: `${document.$id}#/$defs/${name}` });
			expect(validate(valid)).toBe(true);
			expect(source.safeParse(valid).success).toBe(true);
			for (const invalid of [
				{ ...valid, fence: 0 },
				{ ...valid, workloadRevision: 1.5 },
				{ ...valid, imageDigest: "codex:latest" },
				...[
					"actorId",
					"channelId",
					"conversationId",
					"executionId",
					"turnId",
					"hostSessionRef",
					"sessionGeneration",
					"deliveryFence",
					"actionId",
					"actionRevision",
					"allowedCommands",
					"input",
					"selection",
				].map((field) => ({ ...valid, [field]: "forbidden" })),
			]) {
				expect(validate(invalid)).toBe(false);
				expect(source.safeParse(invalid).success).toBe(false);
			}
		}
		const validateClaims = ajv.compile({
			$ref: `${document.$id}#/$defs/WorkloadReadinessGrantClaimsV1`,
		});
		for (const invalid of [
			{ ...claims, purpose: "turn.submit" },
			{ ...claims, audience: "runtime_host" },
		]) {
			expect(validateClaims(invalid)).toBe(false);
			expect(
				WorkloadReadinessGrantClaimsV1Schema.safeParse(invalid).success,
			).toBe(false);
		}
	});
});
