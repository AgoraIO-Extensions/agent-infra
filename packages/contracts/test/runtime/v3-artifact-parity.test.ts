import { readFile } from "node:fs/promises";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { RuntimeOperationFactV2Schema } from "../../src/runtime/events-v2.ts";
import {
	RuntimeBusinessGrantClaimsV2Schema,
	RuntimeControlGrantClaimsV2Schema,
} from "../../src/runtime/grant-v2.ts";

const runtimeArtifacts = [
	"json-schema/runtime.v3.schema.json",
	"openapi/runtime-host.v3.openapi.json",
];

async function validator(path: string, name: string) {
	const document = JSON.parse(
		await readFile(new URL(`../../artifacts/${path}`, import.meta.url), "utf8"),
	);
	const schema = document.$defs
		? { $defs: document.$defs, $ref: `#/$defs/${name}` }
		: {
				components: document.components,
				$ref: `#/components/schemas/${name}`,
			};
	return new Ajv2020({
		strictSchema: false,
		strictTuples: false,
		validateFormats: false,
	}).compile(schema);
}

const commonClaims = {
	schemaVersion: 2,
	issuer: "issuer",
	audience: "runtime_host",
	issuedAt: 1_000,
	expiresAt: 31_000,
	grantId: "grant",
	workerId: "worker",
	principal: { kind: "user", id: "user" },
	agentId: "agent",
	channelId: "web",
	conversationId: "conversation",
	executionId: "execution",
	turnId: "turn",
	sessionGeneration: 1,
	traceId: "trace",
	hostSessionRef: null,
	operation: {
		kind: "execution",
		id: "execution",
		deliveryFence: 1,
		executionDeliveryFence: 1,
	},
	requestDigest: "a".repeat(64),
};

describe("Runtime V3 generated validator parity", () => {
	it.each(runtimeArtifacts)(
		"preserves the single-command authorization boundary in %s",
		async (path) => {
			for (const [name, source, claims] of [
				[
					"RuntimeBusinessGrantClaimsV2",
					RuntimeBusinessGrantClaimsV2Schema,
					{
						...commonClaims,
						purpose: "business",
						authorizationRecordId: "authorization",
						allowedCommands: ["turn.submit"],
						attachments: [{ attachmentId: "attachment", operations: ["read"] }],
					},
				],
				[
					"RuntimeControlGrantClaimsV2",
					RuntimeControlGrantClaimsV2Schema,
					{
						...commonClaims,
						purpose: "control",
						controlRecordId: "control",
						reason: "recovery",
						allowedCommands: ["session.status"],
					},
				],
			] as const) {
				const validate = await validator(path, name);
				expect(source.safeParse(claims).success).toBe(true);
				expect(validate(claims)).toBe(true);
				for (const commands of [
					[],
					[...claims.allowedCommands, "events.ack"],
					[...claims.allowedCommands, ...claims.allowedCommands],
					["tool.invoke"],
				]) {
					const invalid = { ...claims, allowedCommands: commands };
					expect(source.safeParse(invalid).success).toBe(false);
					expect(
						validate(invalid),
						`${name}: ${JSON.stringify(commands)}`,
					).toBe(false);
				}
				for (const issuedAt of [-1, 0, Number.MAX_SAFE_INTEGER + 1]) {
					const input = { ...claims, issuedAt };
					const expected = issuedAt === 0;
					expect(source.safeParse(input).success).toBe(expected);
					expect(validate(input), `${name}: issuedAt ${issuedAt}`).toBe(
						expected,
					);
				}
				if (claims.purpose === "business") {
					for (const operations of [[], ["read", "read"], ["read", "write"]]) {
						const invalid = {
							...claims,
							attachments: [{ attachmentId: "attachment", operations }],
						};
						expect(source.safeParse(invalid).success).toBe(false);
						expect(validate(invalid), JSON.stringify(operations)).toBe(false);
					}
				}
			}
		},
	);

	it.each([
		...runtimeArtifacts,
		"json-schema/pilot-sse.v2.schema.json",
		"openapi/pilot-browser.v2.openapi.json",
	])("preserves nonnegative safe measurements in %s", async (path) => {
		const validate = await validator(path, "RuntimeOperationFactV2");
		const fact = {
			kind: "model",
			operationRef: "operation",
			attemptRef: "attempt",
			phase: "completed",
			model: {
				configVersion: "config",
				modelOptionId: "option",
				modelId: "model",
			},
		};
		expect(validate(fact)).toBe(true);
		expect(RuntimeOperationFactV2Schema.safeParse(fact).success).toBe(true);
		for (const field of [
			"durationMs",
			"inputTokens",
			"outputTokens",
			"cachedInputTokens",
		]) {
			for (const value of [
				-1,
				0,
				1,
				1.5,
				Number.MAX_SAFE_INTEGER,
				Number.MAX_SAFE_INTEGER + 1,
			]) {
				const input = {
					...fact,
					...(field === "durationMs"
						? { durationMs: value }
						: { usage: { [field]: value } }),
				};
				const expected = Number.isSafeInteger(value) && value >= 0;
				expect(RuntimeOperationFactV2Schema.safeParse(input).success).toBe(
					expected,
				);
				expect(validate(input), `${field}: ${value}`).toBe(expected);
			}
		}
	});
});
