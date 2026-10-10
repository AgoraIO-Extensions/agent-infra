import { describe, expect, it } from "vitest";
import {
	createDirectoryOrganizationResolverV1,
	createSnapshot,
	DirectoryUnavailableError,
	MAX_SNAPSHOT_AGE_MS,
} from "./index.js";

const now = Date.UTC(2026, 9, 10);
function snapshot(
	overrides: Partial<Parameters<typeof createSnapshot>[0]> = {},
) {
	return createSnapshot({
		rootDepartmentId: 1,
		startedAt: now,
		completedAt: now,
		departments: [
			{ id: 1, name: "Company", parentId: 0 },
			{ id: 2, name: "Engineering", parentId: 1 },
		],
		members: [
			{
				userId: "wecom-1",
				email: "alice@example.test",
				active: true,
				departmentIds: [2],
			},
		],
		...overrides,
	});
}

describe("Platform directory organization consumer", () => {
	it("maps a unique active LDAP email and binds the snapshot revision", async () => {
		const current = snapshot();
		const resolver = createDirectoryOrganizationResolverV1({
			snapshot: { loadCurrent: async () => current },
			organizationIdForDepartment: (department) =>
				`department:${department.id}`,
			now: () => now + 1,
		});
		expect(await resolver.resolve({ email: "ALICE@example.test" })).toEqual({
			schemaVersion: 1,
			binding: {
				schemaVersion: 1,
				source: "wecom",
				revision: current.revision,
				fetchedAt: current.fetchedAt,
				validUntil: current.validUntil,
			},
			organizationIds: ["department:2"],
		});
	});

	it.each([
		"expired",
		"inactive",
		"duplicate email",
		"missing department mapping",
	] as const)("fails closed for %s", async (failure) => {
		const current = snapshot(
			failure === "expired"
				? {
						startedAt: now - MAX_SNAPSHOT_AGE_MS - 1_000,
						completedAt: now - MAX_SNAPSHOT_AGE_MS - 1_000,
					}
				: failure === "inactive"
					? {
							members: [
								{
									userId: "wecom-1",
									email: "alice@example.test",
									active: false,
									departmentIds: [2],
								},
							],
						}
					: failure === "duplicate email"
						? {
								members: [
									{
										userId: "wecom-1",
										email: "alice@example.test",
										active: true,
										departmentIds: [2],
									},
									{
										userId: "wecom-2",
										email: "alice@example.test",
										active: true,
										departmentIds: [2],
									},
								],
							}
						: {},
		);
		const resolver = createDirectoryOrganizationResolverV1({
			snapshot: { loadCurrent: async () => current },
			organizationIdForDepartment: () =>
				failure === "missing department mapping" ? null : "org-engineering",
			now: () => now + 1,
		});
		await expect(
			resolver.resolve({ email: "alice@example.test" }),
		).rejects.toBeInstanceOf(DirectoryUnavailableError);
	});

	it("does not retain an earlier snapshot after a loader failure", async () => {
		let calls = 0;
		const current = snapshot();
		const resolver = createDirectoryOrganizationResolverV1({
			snapshot: {
				loadCurrent: async () => {
					if (++calls > 1) throw new Error("directory down");
					return current;
				},
			},
			organizationIdForDepartment: () => "org-engineering",
			now: () => now + 1,
		});
		await expect(
			resolver.resolve({ email: "alice@example.test" }),
		).resolves.toMatchObject({
			binding: { revision: current.revision },
		});
		await expect(
			resolver.resolve({ email: "alice@example.test" }),
		).rejects.toBeInstanceOf(DirectoryUnavailableError);
	});
});
