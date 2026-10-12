import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
	NativeMetadataCurrentRequestV1Schema,
	NativeMetadataProjectionV1Schema,
	NativeMetadataRequestIdentityV1Schema,
	PlatformNativeMetadataReadRequestV1Schema,
	RuntimeNativeMetadataBindingRequestV1Schema,
	RuntimeNativeMetadataBindingResponseV1Schema,
	RuntimeNativeMetadataProofClaimsV1Schema,
	RuntimeNativeMetadataReadRequestV1Schema,
	RuntimeNativeMetadataReadResponseV1Schema,
	runtimeNativeMetadataProofSigningPayloadV1,
	runtimeNativeMetadataRequestSigningPayloadV1,
	validateRuntimeNativeMetadataProofClaimsV1,
} from "./native-metadata-v1.ts";

const identity = {
	schemaVersion: 1 as const,
	readId: "11111111-1111-4111-8111-111111111111",
	selector: "commands" as const,
	scope: {
		schemaVersion: 1 as const,
		principal: { kind: "user" as const, id: "user-1" },
		agentId: "agent-1",
		channelId: "channel-1",
		conversationId: "conversation-1",
		executionId: "execution-1",
		sessionGeneration: 1,
		authorizationRevision: "authorization-1",
	},
	readStartedAt: 1_000,
	expiresAt: 20_000,
	requestId: "request-1",
	traceId: "trace-1",
};

describe("Native metadata V1 contracts", () => {
	it("accepts bounded strict command and Skill projections", () => {
		expect(
			NativeMetadataProjectionV1Schema.parse({
				selector: "commands",
				revision: "a".repeat(64),
				capabilities: [
					{
						id: "b".repeat(64),
						kind: "command",
						name: "status",
						description: "Read status",
						source: { name: "codex", version: "0.1.0" },
						parameters: [],
						effect: "read_only",
						availability: "available",
					},
				],
			}),
		).toMatchObject({ selector: "commands" });
		expect(
			NativeMetadataProjectionV1Schema.safeParse({
				selector: "skills",
				revision: "a".repeat(64),
				capabilities: [
					{
						id: "b".repeat(64),
						kind: "skill",
						name: "summary",
						description: "Read summary",
						source: { name: "hub", version: "1.0.0" },
						availability: "discovered",
					},
				],
			}),
		).toMatchObject({ success: true });
	});

	it("rejects duplicate capability ids, extra fields, and excessive lifetime", () => {
		const command = {
			selector: "commands" as const,
			revision: "a".repeat(64),
			capabilities: [],
		};
		expect(
			NativeMetadataProjectionV1Schema.safeParse({
				...command,
				capabilities: [
					{
						id: "b".repeat(64),
						kind: "command",
						name: "a",
						description: "",
						source: { name: "x", version: "1" },
						parameters: [],
						effect: "read_only",
						availability: "available",
					},
					{
						id: "b".repeat(64),
						kind: "command",
						name: "b",
						description: "",
						source: { name: "x", version: "1" },
						parameters: [],
						effect: "read_only",
						availability: "available",
					},
				],
			}),
		).toMatchObject({ success: false });
		expect(
			NativeMetadataRequestIdentityV1Schema.safeParse({
				...identity,
				extra: true,
			}),
		).toMatchObject({ success: false });
		expect(
			NativeMetadataRequestIdentityV1Schema.safeParse({
				...identity,
				expiresAt: 31_001,
			}),
		).toMatchObject({ success: false });
	});

	it("enforces phase-specific host binding and proof identity", () => {
		expect(
			NativeMetadataCurrentRequestV1Schema.safeParse({
				...identity,
				phase: "resolve_original_binding",
				originalHostScopeRef: "host-ref",
			}),
		).toMatchObject({ success: false });
		expect(
			RuntimeNativeMetadataReadRequestV1Schema.safeParse({
				...identity,
				originalHostScopeRef: "host-ref",
				proof: {
					schemaVersion: 1,
					format: "native-metadata-jws",
					token: "signed-token",
				},
			}).success,
		).toBe(true);
		expect(
			RuntimeNativeMetadataReadResponseV1Schema.safeParse({
				...identity,
				originalHostScopeRef: "host-ref",
				projection: {
					selector: "skills",
					revision: "a".repeat(64),
					capabilities: [],
				},
			}).success,
		).toBe(false);
	});

	it("binds bounded proof claims to one request and rejects drift", () => {
		const request = RuntimeNativeMetadataBindingResponseV1Schema.parse({
			...identity,
			originalHostScopeRef: "host-ref",
		});
		const requestDigest = createHash("sha256")
			.update(runtimeNativeMetadataRequestSigningPayloadV1(request))
			.digest("hex");
		const claims = RuntimeNativeMetadataProofClaimsV1Schema.parse({
			...request,
			purpose: "native_metadata_read",
			issuedAt: 2_000,
			issuer: "platform-api",
			audience: "runtime_host.native_metadata_read",
			workerId: "worker-1",
			keyVersion: "metadata-key-v1",
			requestDigest,
		});
		const { purpose: _missingPurpose, ...missingPurpose } = claims;
		expect(
			RuntimeNativeMetadataProofClaimsV1Schema.safeParse(missingPurpose)
				.success,
		).toBe(false);

		expect(
			validateRuntimeNativeMetadataProofClaimsV1(claims, {
				request,
				expectedIssuer: "platform-api",
				expectedWorkerId: "worker-1",
				expectedRequestDigest: requestDigest,
				now: 5_000,
			}),
		).toEqual(claims);
		expect(runtimeNativeMetadataProofSigningPayloadV1(claims)).toContain(
			'"purpose":"native_metadata_read"',
		);

		for (const invalid of [
			{ ...claims, purpose: "runtime_execution" },
			{ ...claims, audience: "runtime_host" },
			{ ...claims, issuer: "i".repeat(257) },
			{ ...claims, keyVersion: "" },
			{ ...claims, issuedAt: 999 },
			{ ...claims, expiresAt: 1_000 },
		]) {
			expect(
				RuntimeNativeMetadataProofClaimsV1Schema.safeParse(invalid).success,
			).toBe(false);
		}
		expect(() =>
			validateRuntimeNativeMetadataProofClaimsV1(claims, {
				request,
				expectedIssuer: "other-issuer",
				expectedWorkerId: "worker-1",
				expectedRequestDigest: requestDigest,
				now: 5_000,
			}),
		).toThrow();
		expect(() =>
			validateRuntimeNativeMetadataProofClaimsV1(
				{ ...claims, scope: { ...claims.scope, agentId: "other-agent" } },
				{
					request,
					expectedIssuer: "platform-api",
					expectedWorkerId: "worker-1",
					expectedRequestDigest: requestDigest,
					now: 5_000,
				},
			),
		).toThrow();
		expect(() =>
			validateRuntimeNativeMetadataProofClaimsV1(
				{ ...claims, requestDigest: "0".repeat(64) },
				{
					request,
					expectedIssuer: "platform-api",
					expectedWorkerId: "worker-1",
					expectedRequestDigest: requestDigest,
					now: 5_000,
				},
			),
		).toThrow();
		expect(() =>
			validateRuntimeNativeMetadataProofClaimsV1(claims, {
				request,
				expectedIssuer: "platform-api",
				expectedWorkerId: "worker-1",
				expectedRequestDigest: requestDigest,
				now: 20_000,
			}),
		).toThrow();
		expect(() =>
			validateRuntimeNativeMetadataProofClaimsV1(claims, {
				request,
				expectedIssuer: "platform-api",
				expectedWorkerId: "worker-1",
				expectedRequestDigest: requestDigest,
				now: 1_000,
			}),
		).toThrow();
	});

	it("applies the lifetime guard to every wire identity and generated JSON Schema", () => {
		const invalid = { ...identity, expiresAt: 31_001 };
		expect(
			PlatformNativeMetadataReadRequestV1Schema.safeParse({
				...invalid,
				apiRequestSourceRef: "api-source",
			}).success,
		).toBe(false);
		expect(
			RuntimeNativeMetadataBindingRequestV1Schema.safeParse(invalid).success,
		).toBe(false);
		expect(
			RuntimeNativeMetadataReadRequestV1Schema.safeParse({
				...invalid,
				originalHostScopeRef: "host-ref",
				proof: {
					schemaVersion: 1,
					format: "native-metadata-jws",
					token: "signed-token",
				},
			}).success,
		).toBe(false);
		const artifact = JSON.parse(
			readFileSync(
				new URL(
					"../../artifacts/json-schema/runtime-native-metadata.v1.schema.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const validate = new Ajv2020({
			strict: true,
			validateFormats: false,
		}).compile({
			$schema: artifact.$schema,
			$defs: artifact.$defs,
			...artifact.$defs.NativeMetadataProjectionV1,
		});
		const command = {
			selector: "commands",
			revision: "a".repeat(64),
			capabilities: [
				{
					id: "b".repeat(64),
					kind: "command",
					name: "status",
					description: "",
					source: { name: "codex", version: "1" },
					parameters: ["unexpected"],
					effect: "read_only",
					availability: "available",
				},
			],
		};
		const definition = artifact.$defs?.NativeMetadataProjectionV1;
		expect(definition).toBeDefined();
		expect(validate(command)).toBe(false);
		const validateClaims = new Ajv2020({
			strict: true,
			validateFormats: false,
		}).compile({
			$schema: artifact.$schema,
			$defs: artifact.$defs,
			...artifact.$defs.RuntimeNativeMetadataProofClaimsV1,
		});
		expect(validateClaims(claimsFixture())).toBe(true);
		expect(validateClaims({ ...claimsFixture(), issuedAt: -1 })).toBe(false);
	});
});

function claimsFixture() {
	const request = RuntimeNativeMetadataBindingResponseV1Schema.parse({
		...identity,
		originalHostScopeRef: "host-ref",
	});
	const requestDigest = createHash("sha256")
		.update(runtimeNativeMetadataRequestSigningPayloadV1(request))
		.digest("hex");
	return {
		...request,
		purpose: "native_metadata_read",
		issuedAt: 2_000,
		issuer: "platform-api",
		audience: "runtime_host.native_metadata_read",
		workerId: "worker-1",
		keyVersion: "metadata-key-v1",
		requestDigest,
	};
}
