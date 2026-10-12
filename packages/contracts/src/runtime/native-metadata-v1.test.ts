import { describe, expect, it } from "vitest";
import {
	NativeMetadataCurrentRequestV1Schema,
	NativeMetadataProjectionV1Schema,
	NativeMetadataRequestIdentityV1Schema,
	RuntimeNativeMetadataReadRequestV1Schema,
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
	});
});
