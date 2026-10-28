import { describe, expect, it } from "vitest";
import {
	requireApiAuditCredentialIdentityV1,
	requireApiCredentialIdentityV1,
} from "./api-audit-identity.js";

const user = {
	schemaVersion: 1,
	userId: "same-id",
	accountStatus: "active",
	organizationIds: [],
	authorizationRevision: "user-1",
};
const credential = {
	schemaVersion: 1,
	credentialId: "credential-1",
	principal: { kind: "user", id: user.userId },
	scopes: ["agent:use"],
	expiresAt: null,
	revokedAt: null,
	createdAt: new Date("2026-10-01T00:00:00Z"),
};
const facts = {
	credential,
	user,
	disabled: false,
	now: new Date("2026-10-02T00:00:00Z"),
};

describe("generic audit credential identity policy", () => {
	it("separates equal user/application IDs without resolving the responsible user", () => {
		const resolvedUser = requireApiAuditCredentialIdentityV1(facts);
		const application = requireApiAuditCredentialIdentityV1({
			...facts,
			user: undefined,
			credential: {
				...credential,
				principal: { kind: "application", id: user.userId },
			},
			application: {
				applicationId: user.userId,
				status: "active",
				authorizationRevision: "app-1",
			},
		});
		expect(resolvedUser.principal).toEqual({ kind: "user", id: user.userId });
		expect(application.principal).toEqual({
			kind: "application",
			id: user.userId,
		});
		expect(application.identityRevision).toBe("app-1");
		expect(application.user).toBeUndefined();
		expect(Object.isFrozen(application.principal)).toBe(true);
	});

	it.each([
		{ scopes: ["agent:read"] },
		{ scopes: ["agent:manage"] },
		{ expiresAt: facts.now },
		{ revokedAt: facts.now },
	])("denies metadata-only or invalidated credentials: %j", (change) => {
		expect(() =>
			requireApiAuditCredentialIdentityV1({
				...facts,
				credential: { ...credential, ...change },
			}),
		).toThrow(
			expect.objectContaining({
				code: expect.stringMatching(/forbidden|authentication_required/),
			}),
		);
	});

	it.each([
		{ disabled: true },
		{ user: { ...user, accountStatus: "disabled" } },
	])("denies disabled users: %j", (change) => {
		expect(() =>
			requireApiAuditCredentialIdentityV1({ ...facts, ...change }),
		).toThrow(expect.objectContaining({ code: "forbidden" }));
	});

	it.each([
		{ user: { ...user, userId: "foreign" } },
		{ credential: { ...credential, scopes: ["agent:use", "invented"] } },
		{ credential: { ...credential, scopes: ["agent:use", "agent:use"] } },
		{ credential: { ...credential, recipientUserId: "caller" } },
		{ now: new Date(Number.NaN) },
		{
			application: {
				applicationId: user.userId,
				status: "active",
				authorizationRevision: "app-1",
			},
		},
	])(
		"fails closed on inconsistent/malformed dependency facts: %j",
		(change) => {
			expect(() =>
				requireApiAuditCredentialIdentityV1({ ...facts, ...change }),
			).toThrow(expect.objectContaining({ code: "unavailable" }));
		},
	);

	it("does not turn a responsible user's identity into an application identity", () => {
		expect(() =>
			requireApiAuditCredentialIdentityV1({
				...facts,
				credential: {
					...credential,
					principal: { kind: "application", id: user.userId },
				},
				application: {
					applicationId: user.userId,
					status: "active",
					authorizationRevision: "app-1",
				},
			}),
		).toThrow(expect.objectContaining({ code: "unavailable" }));
	});
});

it("keeps the explicit Eval envelope separate from every existing Agent scope", () => {
	for (const scope of [
		"agent:create",
		"agent:manage",
		"agent:use",
		"agent:read",
	]) {
		expect(() =>
			requireApiCredentialIdentityV1(
				{ ...facts, credential: { ...credential, scopes: [scope] } },
				"eval:data",
			),
		).toThrow(expect.objectContaining({ code: "forbidden" }));
	}
	const evaluation = {
		...facts,
		credential: { ...credential, scopes: ["eval:data"] },
	};
	expect(
		requireApiCredentialIdentityV1(evaluation, "eval:data").principal,
	).toEqual(credential.principal);
	expect(() => requireApiCredentialIdentityV1(evaluation, "agent:use")).toThrow(
		expect.objectContaining({ code: "forbidden" }),
	);
	expect(() => requireApiAuditCredentialIdentityV1(evaluation)).toThrow(
		expect.objectContaining({ code: "forbidden" }),
	);
});
it("only explicit null authenticates control identity; missing scopes never silently bypass and invalidated identities remain denied", () => {
	const limited = {
		...facts,
		credential: { ...credential, scopes: ["agent:read"] },
	};
	expect(requireApiCredentialIdentityV1(limited, null).principal).toEqual(
		credential.principal,
	);
	for (const scope of [undefined, "invented", false])
		expect(() =>
			Reflect.apply(requireApiCredentialIdentityV1, undefined, [
				limited,
				scope,
			]),
		).toThrow();
	for (const changed of [
		{ ...limited, disabled: true },
		{ ...limited, user: { ...user, accountStatus: "disabled" } },
		{ ...limited, credential: { ...limited.credential, revokedAt: facts.now } },
		{ ...limited, credential: { ...limited.credential, expiresAt: facts.now } },
	])
		expect(() => requireApiCredentialIdentityV1(changed, null)).toThrow();
	for (const scope of [
		"eval:data",
		"eval:run",
		"eval:score",
		"eval:review",
	] as const)
		expect(() => requireApiCredentialIdentityV1(limited, scope)).toThrow(
			expect.objectContaining({ code: "forbidden" }),
		);
});
