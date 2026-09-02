import { BrowserUserProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { describe, expect, it, vi } from "vitest";

import { HttpProtocolError } from "./common";
import {
	hydrateBrowserUsers,
	type IdentityAdapter,
	resolveIdentity,
} from "./identity";

const traceId = "trace-identity";
const activeIdentity = {
	schemaVersion: 1,
	userId: "user-01",
	displayName: "Current User",
	accountStatus: "active",
	organizationIds: ["organization-01"],
	roles: ["employee"],
	authorizationRevision: "authorization-09",
} as const;

function adapter(resolved: unknown, hydrated: unknown = []): IdentityAdapter {
	return {
		resolve: vi.fn().mockResolvedValue(resolved),
		hydrateUsers: vi.fn().mockResolvedValue(hydrated),
	};
}

async function caught(task: Promise<unknown>): Promise<HttpProtocolError> {
	try {
		await task;
		throw new Error("expected task to fail");
	} catch (error) {
		expect(error).toBeInstanceOf(HttpProtocolError);
		return error as HttpProtocolError;
	}
}

describe("trusted identity boundary", () => {
	it("resolves the current identity only through the injected adapter", async () => {
		const identityAdapter = adapter(activeIdentity);
		const request = new Request(
			"https://platform.example.test/api/v1/session?userId=forged",
			{ headers: { "X-User-ID": "forged" } },
		);

		await expect(
			resolveIdentity(identityAdapter, request, traceId),
		).resolves.toEqual(activeIdentity);
		expect(identityAdapter.resolve).toHaveBeenCalledOnce();
		expect(identityAdapter.resolve).toHaveBeenCalledWith(request);
	});

	it("fails closed for missing, disabled, unavailable, or invalid identity", async () => {
		const unavailable = adapter(activeIdentity);
		vi.mocked(unavailable.resolve).mockRejectedValue(
			new Error("private detail"),
		);

		for (const [identityAdapter, code, status] of [
			[undefined, "DEPENDENCY_UNAVAILABLE", 503],
			[adapter(null), "AUTHENTICATION_REQUIRED", 401],
			[
				adapter({ ...activeIdentity, accountStatus: "disabled" }),
				"AUTHORIZATION_REVOKED",
				403,
			],
			[unavailable, "DEPENDENCY_UNAVAILABLE", 503],
			[
				adapter({ ...activeIdentity, userId: "" }),
				"DEPENDENCY_UNAVAILABLE",
				503,
			],
		] as const) {
			const error = await caught(
				resolveIdentity(
					identityAdapter,
					new Request("https://platform.example.test/api/v1/session"),
					traceId,
				),
			);
			expect(error.status).toBe(status);
			expect(error.body.code).toBe(code);
			expect(JSON.stringify(error.body)).not.toContain("private detail");
		}
	});

	it("hydrates only the requested user projections", async () => {
		const projections = [
			{ userId: "user-01", displayName: "One", roles: ["employee"] },
			{
				userId: "user-02",
				displayName: "Two",
				roles: ["employee", "system_admin"],
			},
		];
		const identityAdapter = adapter(activeIdentity, projections);

		const result = await hydrateBrowserUsers(
			identityAdapter,
			["user-02", "user-01"],
			traceId,
		);

		expect(result.map(({ userId }) => userId)).toEqual(["user-02", "user-01"]);
		expect(
			result.every(
				(value) => BrowserUserProjectionV1Schema.safeParse(value).success,
			),
		).toBe(true);
		expect(identityAdapter.hydrateUsers).toHaveBeenCalledWith([
			"user-02",
			"user-01",
		]);
	});

	it("rejects incomplete or extra hydration results", async () => {
		for (const hydrated of [
			[{ userId: "user-01", displayName: "One", roles: ["employee"] }],
			[
				{ userId: "user-01", displayName: "One", roles: ["employee"] },
				{ userId: "other", displayName: "Other", roles: ["employee"] },
			],
		]) {
			const error = await caught(
				hydrateBrowserUsers(
					adapter(activeIdentity, hydrated),
					["user-01", "user-02"],
					traceId,
				),
			);
			expect(error.body.code).toBe("DEPENDENCY_UNAVAILABLE");
		}
	});
});
