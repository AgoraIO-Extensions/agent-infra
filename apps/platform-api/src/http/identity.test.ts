import { BrowserUserProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { describe, expect, it, vi } from "vitest";

import { HttpProtocolError } from "./common";
import {
	describeBrowserOwners,
	hydrateBrowserUsers,
	type IdentityAdapter,
	resolveCurrentMaterialGrantActor,
	resolveCurrentTaskUser,
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

	it("snapshots identity arrays without invoking custom prototypes", async () => {
		let customMapCalls = 0;
		const organizations = ["organization-01"];
		const roles = ["employee"];
		for (const values of [organizations, roles]) {
			Object.setPrototypeOf(values, {
				...Array.prototype,
				map() {
					customMapCalls += 1;
					return ["system_admin"];
				},
			});
		}

		await expect(
			resolveIdentity(
				adapter({
					...activeIdentity,
					organizationIds: organizations,
					roles,
				}),
				new Request("https://platform.example.test/api/v1/session"),
				traceId,
			),
		).resolves.toMatchObject({
			organizationIds: ["organization-01"],
			roles: ["employee"],
		});
		expect(customMapCalls).toBe(0);
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

	it("rejects directory binding leakage into Browser user projections", async () => {
		const error = await caught(
			hydrateBrowserUsers(
				adapter(activeIdentity, [
					{
						userId: "user-01",
						displayName: "One",
						roles: ["employee"],
						directorySnapshotBinding: {
							schemaVersion: 1,
							source: "internal",
							revision: "00000000-0000-4000-8000-000000000001",
							fetchedAt: 1,
							validUntil: 2,
						},
					},
				]),
				["user-01"],
				traceId,
			),
		);
		expect(error.body.code).toBe("DEPENDENCY_UNAVAILABLE");
	});

	it("snapshots hydrated users and roles without invoking custom prototypes", async () => {
		let customMapCalls = 0;
		const roles = ["employee"];
		Object.setPrototypeOf(roles, {
			...Array.prototype,
			map() {
				customMapCalls += 1;
				return ["system_admin"];
			},
		});
		const users = [{ userId: "user-01", displayName: "One", roles }];
		Object.setPrototypeOf(users, {
			...Array.prototype,
			map() {
				customMapCalls += 1;
				return [
					{
						userId: "user-01",
						displayName: "Forged",
						roles: ["system_admin"],
					},
				];
			},
		});

		await expect(
			hydrateBrowserUsers(adapter(activeIdentity, users), ["user-01"], traceId),
		).resolves.toEqual([
			{ userId: "user-01", displayName: "One", roles: ["employee"] },
		]);
		expect(customMapCalls).toBe(0);
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

describe("Agent Owner status boundary (#2910)", () => {
	const owners = [
		{ userId: "user-01", displayName: "One", status: "active" },
		{ userId: "user-02", displayName: "Two", status: "disabled" },
		{ userId: "user-03", displayName: null, status: "departed" },
		{ userId: "user-04", displayName: null, status: "unavailable" },
	] as const;
	const ids = owners.map((owner) => owner.userId);

	it("returns each requested Owner's server status in the requested order", async () => {
		const describeOwners = vi.fn().mockResolvedValue(owners);
		await expect(
			describeBrowserOwners(
				{ ...adapter(activeIdentity), describeOwners },
				ids,
				traceId,
			),
		).resolves.toEqual(owners);
		expect(describeOwners).toHaveBeenCalledWith(ids);
	});

	it("marks every Owner unavailable when the adapter cannot describe status", async () => {
		await expect(
			describeBrowserOwners(
				adapter(activeIdentity, [
					{ userId: "user-01", displayName: "One", roles: ["employee"] },
				]),
				["user-01"],
				traceId,
			),
		).resolves.toEqual([
			{ userId: "user-01", displayName: "One", status: "unavailable" },
		]);
		// 名称逐个尽力读取：一个 Owner 读不到只让它的名称为空，不阻断其他 Owner 或整个详情。
		const hydrateUsers = vi.fn(async (userIds: readonly string[]) => {
			if (userIds.includes("user-02")) throw new Error("private-detail");
			return userIds.map((userId) => ({
				userId,
				displayName: `Name ${userId}`,
				roles: ["employee"],
			}));
		});
		await expect(
			describeBrowserOwners(
				{ resolve: vi.fn(), hydrateUsers },
				["user-01", "user-02"],
				traceId,
			),
		).resolves.toEqual([
			{ userId: "user-01", displayName: "Name user-01", status: "unavailable" },
			{ userId: "user-02", displayName: null, status: "unavailable" },
		]);
	});

	it("fails closed for malformed, reordered, foreign or extra Owner results", async () => {
		for (const described of [
			owners.slice(0, 3),
			[owners[1], owners[0], owners[2], owners[3]],
			[...owners.slice(0, 3), { ...owners[3], userId: "user-foreign" }],
			[...owners.slice(0, 3), { ...owners[3], status: "unknown" }],
			[...owners.slice(0, 3), { ...owners[3], displayName: "" }],
			[...owners.slice(0, 3), { ...owners[3], email: "four@example.test" }],
			[...owners.slice(0, 3), { userId: "user-04", status: "active" }],
		]) {
			const error = await caught(
				describeBrowserOwners(
					{
						...adapter(activeIdentity),
						describeOwners: vi.fn().mockResolvedValue(described),
					},
					ids,
					traceId,
				),
			);
			expect(error.body.code).toBe("DEPENDENCY_UNAVAILABLE");
		}
		const thrown = await caught(
			describeBrowserOwners(
				{
					...adapter(activeIdentity),
					describeOwners: vi
						.fn()
						.mockRejectedValue(new Error("private-ldap-detail")),
				},
				ids,
				traceId,
			),
		);
		expect(thrown.body.code).toBe("DEPENDENCY_UNAVAILABLE");
		expect(JSON.stringify(thrown.body)).not.toContain("private-ldap-detail");
		const duplicate = await caught(
			describeBrowserOwners(
				adapter(activeIdentity),
				["user-01", "user-01"],
				traceId,
			),
		);
		expect(duplicate.body.code).toBe("DEPENDENCY_UNAVAILABLE");
	});
});

describe("current task user directory", () => {
	const current = {
		schemaVersion: 1,
		userId: activeIdentity.userId,
		accountStatus: "active",
		organizationIds: ["current_org"],
		authorizationRevision: "directory_current",
	};
	it("uses the server-resolved user ID and preserves the directory receiver", async () => {
		const identityAdapter = {
			...adapter(activeIdentity),
			current,
			async resolveUser(userId: string) {
				expect(userId).toBe(this.current.userId);
				return this.current;
			},
		};
		expect(
			await resolveCurrentTaskUser(
				identityAdapter,
				activeIdentity.userId,
				traceId,
			),
		).toEqual(current);
		identityAdapter.current = { ...current, accountStatus: "disabled" };
		expect(
			await resolveCurrentTaskUser(
				identityAdapter,
				activeIdentity.userId,
				traceId,
			),
		).toMatchObject({ accountStatus: "disabled" });
		expect(
			await resolveCurrentTaskUser(
				{ ...adapter(activeIdentity), resolveUser: async () => null },
				activeIdentity.userId,
				traceId,
			),
		).toBeNull();
	});
	it.each([
		"absent",
		"method_absent",
		"throw",
		"wrong_user",
		"extra_data",
	] as const)(
		"normalizes %s to a sanitized dependency failure",
		async (mode) => {
			const identityAdapter = {
				...adapter(activeIdentity),
				resolveUser: vi.fn().mockResolvedValue(current),
			};
			if (mode === "throw")
				identityAdapter.resolveUser.mockRejectedValue(
					new Error("private directory response"),
				);
			if (mode === "wrong_user")
				identityAdapter.resolveUser.mockResolvedValue({
					...current,
					userId: "other_user",
				});
			if (mode === "extra_data")
				identityAdapter.resolveUser.mockResolvedValue({
					...current,
					secret: "private directory response",
				});
			const error = await caught(
				resolveCurrentTaskUser(
					mode === "absent"
						? undefined
						: mode === "method_absent"
							? adapter(activeIdentity)
							: identityAdapter,
					activeIdentity.userId,
					traceId,
				),
			);
			expect(error.status).toBe(503);
			expect(error.body).toMatchObject({
				code: "DEPENDENCY_UNAVAILABLE",
				traceId,
			});
			expect(JSON.stringify(error)).not.toContain("private directory response");
		},
	);
});

describe("material-grant actor boundary", () => {
	it("requires the dedicated current LDAP resolver, never ordinary roles", async () => {
		const source = adapter({ ...activeIdentity, roles: ["system_admin"] });
		await expect(
			resolveCurrentMaterialGrantActor(source, "user-01", traceId),
		).rejects.toMatchObject({ status: 503 });
	});
	it.each([
		{ userId: "other" },
		{ ldapStableUid: "" },
		{ ldapAdministratorConfigured: "true" },
		{ isSystemAdmin: "true" },
		{ authorizationRevision: "" },
		{ accountStatus: "unknown" },
	])("rejects invalid actor facts %j", async (invalid) => {
		const source = adapter(activeIdentity);
		source.resolveMaterialGrantActor = vi.fn().mockResolvedValue({
			userId: "user-01",
			accountStatus: "active",
			isSystemAdmin: true,
			ldapStableUid: "stable-uid",
			ldapAdministratorConfigured: true,
			authorizationRevision: "revision",
			...invalid,
		});
		await expect(
			resolveCurrentMaterialGrantActor(source, "user-01", traceId),
		).rejects.toMatchObject({ status: 503 });
	});
});
