import {
	createSnapshot,
	toDirectorySnapshotV2,
} from "@agent-infra/enterprise-directory";
import { describe, expect, it } from "vitest";
import {
	createDirectoryOrganizationAuthorityResolverV1,
	createDirectoryOrganizationIdsResolverV1,
} from "./directory-authority.js";

const now = Date.UTC(2026, 9, 10);
const snapshot = createSnapshot({
	source: "internal",
	rootDepartmentId: 1,
	startedAt: now,
	completedAt: now,
	departments: [
		{ id: 1, name: "Company", parentId: 0 },
		{ id: 2, name: "Engineering", parentId: 1 },
	],
	members: [
		{
			userId: "member-1",
			email: "alice@example.test",
			active: true,
			departmentIds: [2],
		},
	],
});

describe("Platform directory deployment consumer", () => {
	it("preserves the directory binding for consumers that can carry it", async () => {
		const resolveAuthority = createDirectoryOrganizationAuthorityResolverV1({
			endpoint: "https://directory.internal/internal/directory/v2/snapshot",
			token: "t".repeat(32),
			organizationIdForDepartment: (department) => `org:${department.id}`,
			fetch: async () => Response.json(toDirectorySnapshotV2(snapshot)),
		});
		const authority = await resolveAuthority({
			uid: "ldap-1",
			userId: "platform-1",
			email: "alice@example.test",
			displayName: "Alice",
			accountStatus: "active",
			roles: ["employee"],
			authorizationRevision: "identity-1",
		});
		expect(authority).toEqual({
			schemaVersion: 1,
			binding: {
				schemaVersion: 1,
				source: "internal",
				revision: snapshot.revision,
				fetchedAt: snapshot.fetchedAt,
				validUntil: snapshot.validUntil,
			},
			organizationIds: ["org:2"],
		});
	});

	it("maps only the current LDAP email through the snapshot", async () => {
		let requests = 0;
		const organizationIds = createDirectoryOrganizationIdsResolverV1({
			endpoint: "https://directory.internal/internal/directory/v2/snapshot",
			token: "t".repeat(32),
			organizationIdForDepartment: (department) => `org:${department.id}`,
			fetch: async () => {
				requests += 1;
				return Response.json(toDirectorySnapshotV2(snapshot));
			},
		});
		expect(
			await organizationIds({
				uid: "ldap-1",
				userId: "platform-1",
				email: "alice@example.test",
				displayName: "Alice",
				accountStatus: "active",
				roles: ["employee"],
				authorizationRevision: "identity-1",
			}),
		).toEqual(["org:2"]);
		expect(requests).toBe(1);
	});

	it("fails closed instead of falling back when the snapshot is unavailable", async () => {
		const organizationIds = createDirectoryOrganizationIdsResolverV1({
			endpoint: "https://directory.internal/internal/directory/v2/snapshot",
			token: "t".repeat(32),
			organizationIdForDepartment: () => "org:2",
			fetch: async () =>
				Response.json({ error: "directory_unavailable" }, { status: 503 }),
		});
		await expect(
			organizationIds({
				uid: "ldap-1",
				userId: "platform-1",
				email: "alice@example.test",
				displayName: "Alice",
				accountStatus: "active",
				roles: ["employee"],
				authorizationRevision: "identity-1",
			}),
		).rejects.toThrow();
	});
});
