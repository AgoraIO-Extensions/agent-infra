import { describe, expect, it } from "vitest";
import {
	FileAccessClaimsV1Schema,
	FileDescriptorV1Schema,
	parseSandboxReferenceUrlV1,
	RuntimeFileExchangeRequestSchema,
	RuntimeFileExchangeRequestV1Schema,
	RuntimeFileExchangeRequestV2Schema,
	SandboxWorkspaceReferenceV1Schema,
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

	it("carries an optional normalized workspace reference only on result exchanges (#3226)", () => {
		const base = {
			schemaVersion: 2,
			executionGrant: {
				schemaVersion: 4,
				format: "runtime-execution-jws",
				token: "header.payload.signature",
			},
			idempotencyKey: "runtime-result-1",
			operation: "result" as const,
			descriptor: {
				name: "chart.png",
				mediaType: "image/png",
				sizeBytes: 1,
				sha256: "a".repeat(64),
			},
		};
		for (const workspaceReference of ["out/chart.png", "chart.png", null]) {
			const request = { ...base, workspaceReference };
			expect(RuntimeFileExchangeRequestV2Schema.parse(request)).toEqual(
				request,
			);
		}
		for (const workspaceReference of [
			"",
			"/out/chart.png",
			"out/../chart.png",
			"./chart.png",
			"out\\chart.png",
			"sandbox:out/chart.png/",
			"a".repeat(1025),
		])
			expect(
				RuntimeFileExchangeRequestV2Schema.safeParse({
					...base,
					workspaceReference,
				}).success,
				workspaceReference,
			).toBe(false);
		expect(
			RuntimeFileExchangeRequestV2Schema.safeParse({
				...base,
				operation: "read",
				fileId: "file_1",
				descriptor: undefined,
				workspaceReference: "out/chart.png",
			}).success,
		).toBe(false);
		expect(
			RuntimeFileExchangeRequestV1Schema.safeParse({
				schemaVersion: 1,
				operation: "result",
				workspaceReference: "out/chart.png",
			}).success,
		).toBe(false);
	});

	it("normalizes sandbox reference URLs to workspace-relative paths (#3226)", () => {
		for (const [url, workspaceReference] of [
			["sandbox:out/report.pdf", "out/report.pdf"],
			["sandbox:/out/report.pdf", "out/report.pdf"],
			["sandbox:./out//chart.png", "out/chart.png"],
			["sandbox:out/tmp/../chart.png", "out/chart.png"],
			["sandbox:out/my%20chart.png", "out/my chart.png"],
			["sandbox:%E6%8A%A5%E5%91%8A.pdf", "报告.pdf"],
		] as const) {
			expect(parseSandboxReferenceUrlV1(url)).toEqual({
				kind: "reference",
				workspaceReference,
			});
			expect(SandboxWorkspaceReferenceV1Schema.parse(workspaceReference)).toBe(
				workspaceReference,
			);
		}
		for (const url of [
			"out/report.pdf",
			"./out/report.pdf",
			"https://example.test/report.pdf",
			"file:///workspace/report.pdf",
			"SANDBOX:out/report.pdf",
		])
			expect(parseSandboxReferenceUrlV1(url)).toEqual({ kind: "none" });
		for (const url of [
			"sandbox:",
			"sandbox:/",
			"sandbox:.",
			"sandbox:../secret",
			"sandbox:out/../../secret",
			"sandbox:%2E%2E/secret",
			"sandbox:out%5Csecret",
			"sandbox:out\\secret",
			"sandbox:out/%00.png",
			"sandbox:%E0%A4%A",
			`sandbox:${"a".repeat(1025)}`,
		])
			expect(parseSandboxReferenceUrlV1(url), url).toEqual({
				kind: "invalid",
			});
	});
});

it("allows only server-signed Eval execution binding and preserves ordinary legacy claims", () => {
	const old = {
		schemaVersion: 1,
		purpose: "file_access",
		issuer: "fixture",
		audience: "platform_files",
		accessId: "access",
		fileId: "file",
		actorId: "same",
		agentId: "agent",
		channelId: "web",
		conversationId: "conversation",
		operation: "write",
		issuedAt: "2026-01-01T00:00:00Z",
		expiresAt: "2099-01-01T00:00:00Z",
		maxBytes: 5,
		execution: {
			executionId: "execution",
			sessionGeneration: 1,
			grantId: "grant",
		},
	};
	expect(FileAccessClaimsV1Schema.parse(old)).toEqual(old);
	const binding = {
		principal: { kind: "application", id: "same" },
		authorizationRecordId: "record",
		deliveryFence: 1,
	};
	const current = {
		...old,
		channelId: "eval",
		execution: { ...old.execution, evaluation: binding },
	};
	expect(FileAccessClaimsV1Schema.parse(current)).toEqual(current);
	for (const value of [
		{ ...current, execution: null },
		{ ...current, execution: old.execution },
		{ ...old, execution: current.execution },
		{
			...current,
			execution: {
				...current.execution,
				evaluation: {
					...binding,
					principal: { kind: "application", id: "foreign" },
				},
			},
		},
		{
			...current,
			execution: {
				...current.execution,
				evaluation: { ...binding, deliveryFence: 0 },
			},
		},
		{
			...current,
			execution: {
				...current.execution,
				evaluation: { ...binding, owner: true },
			},
		},
	])
		expect(FileAccessClaimsV1Schema.safeParse(value).success).toBe(false);
});
