import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

const generatorPath = fileURLToPath(new URL("./generate.mjs", import.meta.url));
const schemaNames = [
	"IdempotencyKeyV1",
	"OpaqueCursorV1",
	"OpaqueIdV1",
	"ProtocolErrorV1",
	"RequestIdV1",
	"RetryableV1",
	"Rfc3339TimestampV1",
	"SchemaVersionV1",
	"TraceIdV1",
];

function generate() {
	return execFileSync(process.execPath, [generatorPath, "--stdout"], {
		encoding: "utf8",
	});
}

describe("standard contract artifacts", () => {
	it("generates deterministic OpenAPI 3.1 and JSON Schema 2020-12", () => {
		const first = generate();
		const second = generate();
		expect(second).toBe(first);
		expect(first.endsWith("\n")).toBe(true);

		const artifacts = JSON.parse(first);
		expect(artifacts.openapi.openapi).toBe("3.1.0");
		expect(artifacts.openapi.paths).toEqual({});
		expect(Object.keys(artifacts.openapi.components.schemas).sort()).toEqual(
			schemaNames,
		);
		expect(
			artifacts.openapi.components.schemas.ProtocolErrorV1.properties.message,
		).toMatchObject({ minLength: 1, type: "string" });
		expect(
			artifacts.openapi.components.schemas.ProtocolErrorV1.properties.message,
		).not.toHaveProperty("$ref");
		expect(artifacts.jsonSchema.$schema).toBe(
			"https://json-schema.org/draft/2020-12/schema",
		);
		expect(Object.keys(artifacts.jsonSchema.$defs).sort()).toEqual(schemaNames);
		expect(first).not.toMatch(/generatedAt|toolVersion|\/Users\//);
		expect(artifacts.pilotBrowserOpenapi.openapi).toBe("3.1.0");
		expect(artifacts.pilotBrowserOpenapi.paths).toHaveProperty(
			"/api/v1/conversations/{conversationId}/messages",
		);
		expect(artifacts.pilotBrowserOpenapi.paths).toHaveProperty(
			"/api/v1/conversations/{conversationId}/events",
		);
		expect(artifacts.pilotSseJsonSchema.$defs).toHaveProperty(
			"ConversationSseMessageV1",
		);
		expect(artifacts.pilotSseJsonSchema.$defs).toHaveProperty(
			"HeartbeatSignalV1",
		);
		expect(
			Object.keys(artifacts.pilotDelegatedJsonSchema.$defs).sort(),
		).toEqual([
			"DelegatedActionRequestV1",
			"DelegatedActionResultV1",
			"ExecutionGrantClaimsV1",
			"ExecutionGrantCommandV1",
			"ExecutionGrantV1",
		]);
		expect(
			artifacts.pilotDelegatedJsonSchema.$defs.ExecutionGrantClaimsV1.required,
		).toEqual(expect.arrayContaining(["sessionGeneration", "allowedCommands"]));
		expect(
			artifacts.pilotDelegatedJsonSchema.$defs.ExecutionGrantCommandV1.enum,
		).toEqual(expect.arrayContaining(["generation.cancel", "tool.invoke"]));
		expect(artifacts.pilotDelegatedOpenapi.openapi).toBe("3.1.0");
		expect(artifacts.pilotDelegatedOpenapi.paths).toHaveProperty(
			"/internal/v1/delegated-actions.post",
		);
		expect(
			artifacts.pilotDelegatedOpenapi.paths["/internal/v1/delegated-actions"]
				.post.responses,
		).toHaveProperty("503");

		const ajv = new Ajv2020({ strict: true });
		ajv.addFormat("date-time", true);
		ajv.addSchema(artifacts.jsonSchema);
		const validate = ajv.compile({
			$ref: `${artifacts.jsonSchema.$id}#/$defs/ProtocolErrorV1`,
		});
		expect(
			validate({
				schemaVersion: 1,
				code: "RUNTIME_UNAVAILABLE",
				message: "Runtime is temporarily unavailable",
				retryable: true,
				traceId: "01JQY7K9M4N6P8R2T3V5W7X9ZA",
			}),
		).toBe(true);
		const validateTimestamp = ajv.compile({
			$ref: `${artifacts.jsonSchema.$id}#/$defs/Rfc3339TimestampV1`,
		});
		expect(validateTimestamp("2026-12-31T23:59:60Z")).toBe(true);
		expect(validateTimestamp("2026-08-28t03:00:00z")).toBe(true);
		ajv.addSchema(artifacts.pilotSseJsonSchema);
		const validateHeartbeat = ajv.compile({
			$ref: `${artifacts.pilotSseJsonSchema.$id}#/$defs/HeartbeatSignalV1`,
		});
		expect(
			validateHeartbeat({
				schemaVersion: 1,
				kind: "control",
				type: "heartbeat",
				occurredAt: "2026-08-28T10:00:00Z",
			}),
		).toBe(true);
	});

	it("rejects deliberately stale committed artifacts", async () => {
		const root = await mkdtemp(
			resolve(tmpdir(), "agent-infra-stale-contracts-"),
		);
		try {
			await mkdir(resolve(root, "json-schema"), { recursive: true });
			await mkdir(resolve(root, "openapi"), { recursive: true });
			await writeFile(
				resolve(root, "json-schema/common.v1.schema.json"),
				"{}\n",
			);
			await writeFile(resolve(root, "openapi/common.v1.openapi.json"), "{}\n");

			const result = spawnSync(
				process.execPath,
				[generatorPath, "--check", "--root", root],
				{ encoding: "utf8" },
			);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("Generated contract artifacts are stale");
			expect(result.stderr).toContain("pilot-delegated.v1.schema.json");
			expect(result.stderr).toContain("pilot-delegated.v1.openapi.json");
		} finally {
			await rm(root, { recursive: true });
		}
	});
});
