import {
	createSnapshot,
	type DirectorySnapshot,
} from "@agent-infra/enterprise-directory";
import { createWecomEmployeeIdentity } from "@agent-infra/identity";
import { createWecomAuthorizationV1 } from "@agent-infra/platform-core";
import {
	migratePlatformDatabase,
	PostgresOidcIdentityStore,
} from "@agent-infra/platform-store";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { createOidcEmployeeDirectory } from "../../platform-api/src/oidc-employee-directory.js";

let db: PostgresTestDatabase;
let store: PostgresOidcIdentityStore;
beforeAll(async () => {
	db = await startPostgresTestDatabase("4434-wecom");
	await migratePlatformDatabase(db);
	store = new PostgresOidcIdentityStore(db.databaseUrl);
}, 60_000);
afterAll(async () => {
	await store?.close();
	await db?.stop();
});

const issuer = "https://company.example.test/agentinfra";
const scope = {
	agentId: "agent-1",
	bindingReference: "binding-1",
	kind: "wecom_bot" as const,
	senderId: "encrypted-employee",
	peerId: "peer",
	conversationType: "single" as const,
	threadId: null,
};
function createFixture() {
	const now = Date.now();
	let current: DirectorySnapshot = createSnapshot({
		rootDepartmentId: 1,
		startedAt: now,
		completedAt: now,
		departments: [
			{ id: 1, name: "Company", parentId: 0 },
			{ id: 2, name: "Other", parentId: 1 },
		],
		members: ["employee", "other", "owner"].map((id) => ({
			userId: id,
			email: `${id}@example.test`,
			active: true,
			departmentIds: [id === "other" ? 2 : 1],
		})),
	});
	const disabled = new Set<string>();
	const snapshot = { loadCurrent: async () => current };
	const authority = createWecomEmployeeIdentity(
		{
			snapshot,
			organizationIdForDepartment: (d) => `org-${d.id}`,
			verifiedWecomMember: async (scope) => {
				if (scope.kind === "wecom_app") {
					return scope.bindingReference === "app-binding" &&
						scope.senderId === "employee"
						? { source: "wecom", userId: "employee" }
						: null;
				}
				if (scope.bindingReference !== "binding-1") return null;
				const id = {
					"encrypted-employee": "employee",
					"encrypted-other": "other",
				}[scope.senderId];
				return id ? { source: "wecom", userId: id } : null;
			},
		},
		store,
		(id) => Promise.resolve(disabled.has(id)),
	);
	const browser = createOidcEmployeeDirectory(
		{
			issuer,
			clientId: "test",
			clientSecret: "fixture-secret",
			allowEmailLink: true,
		},
		store,
		snapshot,
	);
	return {
		authority,
		browser,
		disabled,
		replace: (change: Partial<DirectorySnapshot>) => {
			current = { ...current, ...change };
		},
	};
}
it("accepts a verified department member before web login and retains their stable ID on web login and channel reauthorization", async () => {
	const { authority, browser, disabled } = createFixture();
	const login = (id: string) =>
		browser.verifiedAccount({
			issuer,
			subject: `subject-${id}`,
			email: `${id}@example.test`,
			emailVerified: true,
		});
	const owner = await login("owner");
	if (!owner) throw new Error("missing owner");
	const channel = createWecomAuthorizationV1({
		identity: authority.identity,
		state: {
			readAuthorityState: async () => ({
				management: {
					schemaVersion: 1,
					agentId: scope.agentId,
					applicationId: "app-1",
					applicantId: owner.userId,
					status: "available",
					revision: 1,
					approvalRevision: 1,
					decisionReason: null,
					serviceAvailability: "ready",
					desiredState: "running",
					workloadRevision: 1,
					fence: 1,
					ownerIds: [owner.userId],
					availability: [{ kind: "organization", organizationId: "org-1" }],
					failureCode: null,
				},
				configuration: {
					schemaVersion: 2,
					agentId: scope.agentId,
					revision: 1,
					source: {
						kind: "custom",
						imageDigest: `sha256:${"a".repeat(64)}`,
						admissionRevision: "trusted",
						interactionMode: "platform-adapter",
						connectionEnabled: false,
					},
					modelConfiguration: null,
					actions: [],
					actionSetRevision: "v1",
					environment: [],
					secrets: [],
					channels: [
						{ kind: scope.kind, bindingReference: scope.bindingReference },
					],
					channelRevision: "v1",
				},
				authorizationRevision: "rev-1",
			}),
		},
	});
	const first = await channel.authorize(scope);
	if (first.outcome !== "allowed")
		throw new Error("expected department admission");
	const id = first.authority.actor.actorId;
	expect(await login("employee")).toMatchObject({ userId: id });
	expect(
		await channel.authorize(scope, "use", first.authority.actor.taskBoundary),
	).toMatchObject({
		outcome: "allowed",
		authority: { actor: { actorId: id } },
	});
	expect(
		await channel.authorize({ ...scope, senderId: "encrypted-other" }),
	).toMatchObject({ outcome: "denied" });
	expect(
		await channel.authorize({ ...scope, senderId: "employee" }),
	).toMatchObject({ outcome: "denied" });
	expect(
		await channel.authorize({ ...scope, bindingReference: "wrong" }),
	).toMatchObject({ outcome: "denied" });
	disabled.add(id);
	expect(await channel.authorize(scope)).toMatchObject({ outcome: "denied" });
});
it("resolves a verified WeCom application callback only under its application binding", async () => {
	const { authority } = createFixture();
	const signed = {
		...scope,
		kind: "wecom_app" as const,
		bindingReference: "app-binding",
		senderId: "employee",
	};
	const user = await authority.identity.resolveSender(signed);
	expect(user?.accountStatus).toBe("active");
	expect(await authority.identity.resolveSender(scope)).toMatchObject({
		userId: user?.userId,
	});
	expect(
		await authority.identity.resolveSender({
			...signed,
			bindingReference: scope.bindingReference,
		}),
	).toBeNull();
	expect(
		await authority.identity.resolveSender({
			...scope,
			senderId: signed.senderId,
		}),
	).toBeNull();
});
it("rejects incomplete, stale and ambiguous directory publications independently", async () => {
	const { authority, replace } = createFixture();
	replace({ complete: false as true });
	await expect(authority.identity.resolveSender(scope)).rejects.toThrow();
	const yesterday = Date.now() - 86_400_000;
	replace({
		complete: true,
		fetchedAt: yesterday - 1_000,
		validUntil: yesterday,
	});
	await expect(authority.identity.resolveSender(scope)).rejects.toThrow();
	replace({
		fetchedAt: Date.now() - 1_000,
		validUntil: Date.now() + 5000,
		members: ["employee", "another"].map((userId) => ({
			userId,
			email: "employee@example.test",
			active: true,
			departmentIds: [1],
		})),
	});
	expect(await authority.identity.resolveSender(scope)).toBeNull();
});
