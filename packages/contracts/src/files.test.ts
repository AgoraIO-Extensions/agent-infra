import { describe, expect, it } from "vitest";
import {
	FileAccessClaimsV1Schema,
	FileDescriptorV1Schema,
	RuntimeFileExchangeRequestV1Schema,
} from "./files.ts";

describe("file authority wire boundary", () => {
	it("accepts bounded descriptors and rejects caller-selected storage or owner", () => {
		const descriptor = {
			name: "report.txt",
			mediaType: "text/plain",
			sizeBytes: 5,
			sha256:
				"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
		};
		expect(FileDescriptorV1Schema.parse(descriptor)).toEqual(descriptor);
		expect(
			FileDescriptorV1Schema.safeParse({ ...descriptor, objectKey: "other" })
				.success,
		).toBe(false);
		expect(
			FileDescriptorV1Schema.safeParse({ ...descriptor, ownerId: "other" })
				.success,
		).toBe(false);
		expect(
			FileDescriptorV1Schema.safeParse({ ...descriptor, sizeBytes: -1 })
				.success,
		).toBe(false);
	});
	it("keeps execution file authorization separate from the old runtime audience", () => {
		const claims = {
			schemaVersion: 1,
			purpose: "file_access",
			issuer: "platform",
			audience: "platform_files",
			accessId: "access_1",
			fileId: "file_1",
			actorId: "actor_1",
			agentId: "agent_1",
			channelId: "web",
			conversationId: "conversation_1",
			operation: "write",
			issuedAt: "2026-09-15T00:00:00Z",
			expiresAt: "2026-09-15T00:01:00Z",
			maxBytes: 5,
			execution: {
				executionId: "execution_1",
				sessionGeneration: 1,
				grantId: "grant_1",
			},
		};
		expect(FileAccessClaimsV1Schema.parse(claims)).toEqual(claims);
		expect(
			FileAccessClaimsV1Schema.safeParse({
				...claims,
				audience: "runtime_host",
			}).success,
		).toBe(false);
		expect(
			FileAccessClaimsV1Schema.safeParse({
				...claims,
				execution: { ...claims.execution, sessionGeneration: 0 },
			}).success,
		).toBe(false);
	});
	it("binds V4 file exchange operations to one execution and strict operation fields", () => {
		const binding = {
			schemaVersion: 1,
			actorId: "actor_1",
			agentId: "agent_1",
			channelId: "web",
			conversationId: "conversation_1",
			executionId: "execution_1",
			sessionGeneration: 2,
			grantId: "grant_1",
			expiresAt: "2026-09-15T00:01:00Z",
			idempotencyKey: "exchange_1",
		};
		const read = {
			...binding,
			operation: "read" as const,
			fileId: "file_1",
		};
		expect(RuntimeFileExchangeRequestV1Schema.parse(read)).toEqual(read);
		expect(
			RuntimeFileExchangeRequestV1Schema.safeParse({
				...read,
				descriptor: {
					name: "wrong.txt",
					mediaType: "text/plain",
					sizeBytes: 1,
					sha256: "a".repeat(64),
				},
			}).success,
		).toBe(false);
		const result = {
			...binding,
			operation: "result" as const,
			descriptor: {
				name: "result.txt",
				mediaType: "text/plain",
				sizeBytes: 1,
				sha256: "a".repeat(64),
			},
		};
		expect(RuntimeFileExchangeRequestV1Schema.parse(result)).toEqual(result);
		expect(
			RuntimeFileExchangeRequestV1Schema.safeParse({
				...result,
				grantToken: "must-not-be-in-wire",
			}).success,
		).toBe(false);
	});
});
