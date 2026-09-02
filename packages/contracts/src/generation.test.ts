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
		maxBuffer: 8 * 1024 * 1024,
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
		expect(Object.keys(artifacts.pilotBrowserOpenapiV2.paths)).toEqual([
			"/api/v2/admin/audit",
		]);
		expect(artifacts.pilotBrowserOpenapiV2.components.schemas).toHaveProperty(
			"PlatformAuditProjectionV2",
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
			"DelegatedActionErrorV1",
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
		expect(artifacts.kubernetesWorkloadJsonSchema.$schema).toBe(
			"https://json-schema.org/draft/2020-12/schema",
		);
		expect(artifacts.kubernetesWorkloadJsonSchema.$defs).toHaveProperty(
			"AgentWorkloadDesiredV1",
		);
		expect(artifacts.kubernetesWorkloadJsonSchema.$defs).toHaveProperty(
			"WorkloadCleanupResultV1",
		);
		expect(artifacts.registryManifestJsonSchema.$schema).toBe(
			"https://json-schema.org/draft/2020-12/schema",
		);
		expect(artifacts.registryManifestJsonSchema.$defs).toHaveProperty(
			"ImageRegistryAdmissionResultV1",
		);
		expect(artifacts.registryManifestJsonSchema.$defs).toHaveProperty(
			"RuntimeManifestV1",
		);
		expect(artifacts.secretLifecycleJsonSchema.$schema).toBe(
			"https://json-schema.org/draft/2020-12/schema",
		);
		expect(artifacts.secretLifecycleJsonSchema.$defs).toHaveProperty(
			"PlatformSecretRecordV1",
		);
		expect(artifacts.secretLifecycleJsonSchema.$defs).toHaveProperty(
			"SecretEncryptionKeySetV1",
		);
		expect(artifacts.workerResultJsonSchema.$schema).toBe(
			"https://json-schema.org/draft/2020-12/schema",
		);
		expect(Object.keys(artifacts.workerResultJsonSchema.$defs)).toEqual([
			"WorkerWorkloadErrorV1",
			"WorkerWorkloadExpectedRevisionV1",
			"WorkerWorkloadResultV1",
		]);
		expect(artifacts.runtimeOpenapi.openapi).toBe("3.1.0");
		expect(artifacts.runtimeOpenapi.security).toEqual([
			{ RuntimeServiceBearer: [] },
		]);
		expect(
			artifacts.runtimeOpenapi.components.securitySchemes.RuntimeServiceBearer,
		).toEqual({ type: "http", scheme: "bearer" });
		expect(Object.keys(artifacts.runtimeOpenapi.paths).sort()).toEqual([
			"/internal/runtime/v1/capabilities",
			"/internal/runtime/v1/events/replay",
			"/internal/runtime/v1/events/stream",
			"/internal/runtime/v1/generations/cancel",
			"/internal/runtime/v1/instructions",
			"/internal/runtime/v1/status",
			"/internal/runtime/v1/stops",
			"/internal/runtime/v1/turns",
		]);
		expect(JSON.stringify(artifacts.runtimeOpenapi)).not.toMatch(
			/nativeSessionRef|RuntimeDriver/,
		);
		for (const path of Object.values(artifacts.runtimeOpenapi.paths) as Array<{
			post: { responses: Record<string, unknown> };
		}>) {
			expect(Object.keys(path.post.responses).sort()).toEqual([
				"200",
				"400",
				"401",
				"403",
				"404",
				"409",
				"500",
				"503",
			]);
		}
		expect(Object.keys(artifacts.runtimeJsonSchema.$defs)).toEqual(
			expect.arrayContaining([
				"RuntimeDriverCommandV1",
				"RuntimeEventV1",
				"RuntimeSubmitTurnRequestV1",
			]),
		);

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
		ajv.addSchema(artifacts.pilotDelegatedJsonSchema);
		for (const name of Object.keys(artifacts.pilotDelegatedJsonSchema.$defs)) {
			expect(() =>
				ajv.compile({
					$ref: `${artifacts.pilotDelegatedJsonSchema.$id}#/$defs/${name}`,
				}),
			).not.toThrow();
		}
		ajv.addSchema(artifacts.kubernetesWorkloadJsonSchema);
		for (const name of Object.keys(
			artifacts.kubernetesWorkloadJsonSchema.$defs,
		)) {
			expect(() =>
				ajv.compile({
					$ref: `${artifacts.kubernetesWorkloadJsonSchema.$id}#/$defs/${name}`,
				}),
			).not.toThrow();
		}
		ajv.addSchema(artifacts.registryManifestJsonSchema);
		const validateDigest = ajv.compile({
			$ref: `${artifacts.registryManifestJsonSchema.$id}#/$defs/ImmutableOciDigestV1`,
		});
		expect(validateDigest(`sha256:${"a".repeat(64)}`)).toBe(true);
		const validateManifest = ajv.compile({
			$ref: `${artifacts.registryManifestJsonSchema.$id}#/$defs/RuntimeManifestV1`,
		});
		expect(
			validateManifest({
				schemaVersion: 1,
				interactionMode: "platform-adapter",
				protocol: "acp",
				service: { port: 8080 },
				health: { path: "/healthz" },
				capabilities: { modelSelection: true },
			}),
		).toBe(true);
		expect(
			validateManifest({
				schemaVersion: 1,
				interactionMode: "self-managed",
				service: { port: 8080 },
				health: { path: "/healthz" },
				capabilities: { connection: true },
			}),
		).toBe(true);
		ajv.addSchema(artifacts.secretLifecycleJsonSchema);
		for (const name of Object.keys(artifacts.secretLifecycleJsonSchema.$defs)) {
			expect(() =>
				ajv.compile({
					$ref: `${artifacts.secretLifecycleJsonSchema.$id}#/$defs/${name}`,
				}),
			).not.toThrow();
		}
		ajv.addSchema(artifacts.workerResultJsonSchema);
		for (const name of Object.keys(artifacts.workerResultJsonSchema.$defs)) {
			expect(() =>
				ajv.compile({
					$ref: `${artifacts.workerResultJsonSchema.$id}#/$defs/${name}`,
				}),
			).not.toThrow();
		}
		ajv.addSchema(artifacts.runtimeJsonSchema);
		const validateRuntimeEvent = ajv.compile({
			$ref: `${artifacts.runtimeJsonSchema.$id}#/$defs/RuntimeEventV1`,
		});
		expect(
			validateRuntimeEvent({
				schemaVersion: 1,
				adapterEventKey: "event-1",
				executionId: "execution-1",
				cursor: "cursor-1",
				occurredAt: "2026-08-28T10:00:00Z",
				type: "status",
				payload: { status: "running" },
			}),
		).toBe(true);
	}, 15_000);

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
			expect(result.stderr).toContain("pilot-browser.v2.openapi.json");
			expect(result.stderr).toContain("registry-manifest.v1.schema.json");
		} finally {
			await rm(root, { recursive: true });
		}
	});
});
