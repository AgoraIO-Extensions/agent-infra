import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	grantApplicationManager,
	grantUserApiUse,
	revokeUserApiUse,
} from "./agent-authorization.js";

const { grant, grantUser, revokeUser } = vi.hoisted(() => ({
	grant: vi.fn(),
	grantUser: vi.fn(),
	revokeUser: vi.fn(),
}));

vi.mock("../../pilot/generated-v2/sdk.gen.js", () => ({
	grantAgentApplicationManagerV1: grant,
	grantAgentApplicationUseV1: vi.fn(),
	grantAgentUserApiUseV1: grantUser,
	revokeAgentApplicationManagerV1: vi.fn(),
	revokeAgentApplicationUseV1: vi.fn(),
	revokeAgentUserApiUseV1: revokeUser,
}));

beforeEach(() => {
	vi.clearAllMocks();
	grant.mockResolvedValue({
		data: {
			agentId: "agent-1",
			applicationId: "application-1",
			authorizationRevision: "auth-1",
			granted: true,
			replayed: false,
			schemaVersion: 1,
		},
		response: { status: 200 },
	});
	revokeUser.mockResolvedValue({
		data: {
			agentId: "agent-1",
			authorizationRevision: null,
			granted: false,
			replayed: true,
			schemaVersion: 1,
			userId: "user-1",
		},
		response: { status: 200 },
	});
	grantUser.mockResolvedValue({
		data: {
			agentId: "agent-1",
			authorizationRevision: "auth-2",
			granted: true,
			replayed: false,
			schemaVersion: 1,
			userId: "user-1",
		},
		response: { status: 200 },
	});
});

describe("agent authorization commands", () => {
	it("generates a distinct idempotency key per operation attempt", async () => {
		await grantApplicationManager("agent-1", "application-1");
		await grantApplicationManager("agent-1", "application-1");

		const first = grant.mock.calls[0]?.[0];
		const second = grant.mock.calls[1]?.[0];
		expect(first.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/u);
		expect(second.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/u);
		expect(first.headers["Idempotency-Key"]).not.toBe(
			second.headers["Idempotency-Key"],
		);
	});

	it("passes user revoke revision and preserves replay metadata", async () => {
		await expect(revokeUserApiUse("agent-1", "user-1", 7)).resolves.toEqual(
			expect.objectContaining({
				authorizationRevision: null,
				replayed: true,
			}),
		);
		expect(revokeUser).toHaveBeenCalledWith(
			expect.objectContaining({
				body: { expectedRevision: 7, schemaVersion: 1 },
				path: { agentId: "agent-1", userId: "user-1" },
				headers: { "Idempotency-Key": expect.any(String) },
			}),
		);
	});

	it("passes user grant revision and requires a confirmed 200 response", async () => {
		await expect(grantUserApiUse("agent-1", "user-1", 1)).resolves.toEqual(
			expect.objectContaining({
				authorizationRevision: "auth-2",
				granted: true,
			}),
		);
		expect(grantUser).toHaveBeenCalledWith(
			expect.objectContaining({
				body: { expectedRevision: 1, schemaVersion: 1 },
				path: { agentId: "agent-1", userId: "user-1" },
				headers: { "Idempotency-Key": expect.any(String) },
			}),
		);
	});
});
