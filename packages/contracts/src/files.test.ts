import { describe, expect, it } from "vitest";
import {
	FileAccessClaimsV1Schema,
	FileDescriptorV1Schema,
	RuntimeFileExchangeRequestSchema,
	RuntimeFileExchangeRequestV1Schema,
	RuntimeFileExchangeRequestV2Schema,
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
		expect(
			RuntimeFileExchangeRequestV1Schema.safeParse(
				(({ fileId: _fileId, ...missingFile } = read) => missingFile)(read),
			).success,
		).toBe(false);
		expect(
			RuntimeFileExchangeRequestV1Schema.safeParse({
				...result,
				fileId: "must-not-be-on-result",
			}).success,
		).toBe(false);
		expect(
			RuntimeFileExchangeRequestV1Schema.safeParse({
				...read,
				idempotencyKey: "a".repeat(129),
			}).success,
		).toBe(false);
		expect(
			RuntimeFileExchangeRequestV1Schema.safeParse({
				...read,
				idempotencyKey: "bad key",
			}).success,
		).toBe(false);
		expect(
			RuntimeFileExchangeRequestV1Schema.safeParse({
				...read,
				sessionGeneration: 0,
			}).success,
		).toBe(false);
		expect(
			RuntimeFileExchangeRequestV1Schema.safeParse({
				...binding,
				operation: "result",
			}).success,
		).toBe(false);
		expect(
			RuntimeFileExchangeRequestV1Schema.safeParse({
				...read,
				actorId: "",
			}).success,
		).toBe(false);
		expect(
			RuntimeFileExchangeRequestV1Schema.safeParse({
				...read,
				expiresAt: "not-a-timestamp",
			}).success,
		).toBe(false);
	});

	it("accepts only the signed V4 grant as V2 exchange evidence", () => {
		const executionGrant = {
			schemaVersion: 4,
			format: "runtime-execution-jws",
			token: "header.payload.signature",
		};
		const binding = {
			schemaVersion: 2,
			executionGrant,
			idempotencyKey: "runtime-read-1",
		};
		const read = { ...binding, operation: "read" as const, fileId: "file_1" };
		expect(RuntimeFileExchangeRequestV2Schema.parse(read)).toEqual(read);
		expect(RuntimeFileExchangeRequestSchema.parse(read)).toEqual(read);
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
		expect(RuntimeFileExchangeRequestV2Schema.parse(result)).toEqual(result);
		// Every former self-reported authority field is gone from the V2 wire.
		for (const claim of [
			{ actorId: "actor_1" },
			{ agentId: "agent_1" },
			{ channelId: "web" },
			{ conversationId: "conversation_1" },
			{ executionId: "execution_1" },
			{ sessionGeneration: 1 },
			{ grantId: "grant_1" },
			{ expiresAt: "2099-01-01T00:00:00Z" },
		]) {
			expect(
				RuntimeFileExchangeRequestV2Schema.safeParse({ ...read, ...claim })
					.success,
			).toBe(false);
		}
		expect(
			RuntimeFileExchangeRequestV2Schema.safeParse({
				...read,
				executionGrant: { ...executionGrant, schemaVersion: 3 },
			}).success,
		).toBe(false);
		expect(
			RuntimeFileExchangeRequestV2Schema.safeParse({
				...read,
				executionGrant: undefined,
			}).success,
		).toBe(false);
		// The self-reported V1 wire stays a separate strict request.
		expect(
			RuntimeFileExchangeRequestSchema.safeParse({
				schemaVersion: 1,
				operation: "read",
				actorId: "actor_1",
				fileId: "file_1",
			}).success,
		).toBe(false);
	});
});
