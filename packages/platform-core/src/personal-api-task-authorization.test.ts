import { describe, expect, it, vi } from "vitest";
import {
	type PersonalApiTaskAdmissionAuthorityV1,
	parsePersonalApiTaskAdmissionAuthorityV1,
	requirePersonalApiTaskBindingV1,
	requirePersonalApiTaskUseAuthorizationV1,
} from "./personal-api-task-authorization.js";

const authority: PersonalApiTaskAdmissionAuthorityV1 = {
	schemaVersion: 1,
	principal: { kind: "user", id: "user_1" },
	credentialId: "credential_secret_reference",
	credentialHash: "a".repeat(64),
	agentId: "agent_1",
	channelId: "api",
	operation: "agent:use",
	identityRevision: "identity_1",
	useGrantRevision: "use_1",
};
const binding = {
	principal: authority.principal,
	actorId: authority.principal.id,
	agentId: authority.agentId,
	channelId: "api",
};
const facts = {
	authority,
	credential: {
		id: authority.credentialId,
		credentialHash: authority.credentialHash,
		principalType: "user",
		principalId: "user_1",
		scopes: ["agent:use"],
		expiresAt: null,
		revokedAt: null,
	},
	user: {
		schemaVersion: 1 as const,
		userId: "user_1",
		accountStatus: "active" as const,
		organizationIds: ["owner_organization"],
		authorizationRevision: "identity_1",
	},
	disabled: false,
	grant: {
		agentId: "agent_1",
		principalType: "user",
		principalId: "user_1",
		grantType: "use",
		authorizationRevision: "use_1",
		revokedAt: null,
	},
	now: new Date("2026-10-01T00:00:00Z"),
};

describe("personal API Task authority", () => {
	it("copies and freezes server facts without putting credential references in the policy result", () => {
		const input = { ...authority, principal: { ...authority.principal } };
		const parsed = parsePersonalApiTaskAdmissionAuthorityV1(input);
		input.principal.id = "replacement";
		expect(parsed.principal.id).toBe("user_1");
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.principal)).toBe(true);
		requirePersonalApiTaskBindingV1(parsed, binding);
		const result = requirePersonalApiTaskUseAuthorizationV1({
			...facts,
			authority: parsed,
		});
		expect(result).toEqual({
			principal: { kind: "user", id: "user_1" },
			agentId: "agent_1",
			channelId: "api",
			identityRevision: "identity_1",
			useGrantRevision: "use_1",
		});
		expect(JSON.stringify(result)).not.toContain(authority.credentialId);
		expect(JSON.stringify(result)).not.toContain(authority.credentialHash);
	});

	it.each([
		{ principal: { kind: "application", id: "user_1" } },
		{ operation: "agent:read" },
		{ channelId: "web" },
		{ credentialHash: "raw_credential" },
		{ principal: { kind: "user", id: "user_1", role: "admin" } },
		{ identityRevision: "" },
		{ useGrantRevision: "" },
		{ callerRole: "owner" },
	])("rejects unsupported or extra authority fields: %j", (replacement) => {
		expect(() =>
			parsePersonalApiTaskAdmissionAuthorityV1({
				...authority,
				...replacement,
			}),
		).toThrow(expect.objectContaining({ code: "invalid_input" }));
	});

	it("rejects accessors without invoking them", () => {
		const getter = vi.fn(() => "user_1");
		const input = { ...authority };
		Object.defineProperty(input, "credentialId", { get: getter });
		expect(() => parsePersonalApiTaskAdmissionAuthorityV1(input)).toThrow();
		expect(getter).not.toHaveBeenCalled();
	});

	it.each(["authority", "principal", "binding", "binding_principal"])(
		"rejects an own __proto__ data key in %s before snapshotting",
		(target) => {
			const input = { ...authority, principal: { ...authority.principal } };
			const candidateBinding = {
				...binding,
				principal: { ...binding.principal },
			};
			const recipient =
				target === "authority"
					? input
					: target === "principal"
						? input.principal
						: target === "binding"
							? candidateBinding
							: candidateBinding.principal;
			Object.defineProperty(recipient, "__proto__", {
				value: { role: "admin" },
				enumerable: true,
			});
			if (target === "authority" || target === "principal") {
				expect(() => parsePersonalApiTaskAdmissionAuthorityV1(input)).toThrow(
					expect.objectContaining({ code: "invalid_input" }),
				);
			} else {
				expect(() =>
					requirePersonalApiTaskBindingV1(authority, candidateBinding),
				).toThrow(expect.objectContaining({ code: "forbidden" }));
			}
		},
	);

	it.each([
		{ principal: { kind: "application", id: "user_1" } },
		{ principal: { kind: "user", id: "user_2" } },
		{ actorId: "user_2" },
		{ agentId: "agent_2" },
		{ channelId: "web" },
		{ role: "admin" },
	])(
		"rejects caller binding substitution before a transaction check: %j",
		(replacement) => {
			expect(() =>
				requirePersonalApiTaskBindingV1(authority, {
					...binding,
					...replacement,
				}),
			).toThrow(expect.objectContaining({ code: "forbidden" }));
		},
	);

	it.each([
		["missing", null],
		["another ID", { ...facts.credential, id: "another_valid_credential" }],
		[
			"replaced material",
			{ ...facts.credential, credentialHash: "b".repeat(64) },
		],
		["another user", { ...facts.credential, principalId: "user_2" }],
		["application", { ...facts.credential, principalType: "application" }],
		["revoked", { ...facts.credential, revokedAt: facts.now }],
		["expired", { ...facts.credential, expiresAt: facts.now }],
	] as const)("rejects the %s exact credential", (_, credential) => {
		expect(() =>
			requirePersonalApiTaskUseAuthorizationV1({ ...facts, credential }),
		).toThrow(expect.objectContaining({ code: "authentication_required" }));
	});

	it.each(["agent:read", "agent:manage", "agent:create"])(
		"requires credential use scope even with a valid use grant (%s)",
		(scope) => {
			expect(() =>
				requirePersonalApiTaskUseAuthorizationV1({
					...facts,
					credential: { ...facts.credential, scopes: [scope] },
				}),
			).toThrow(expect.objectContaining({ code: "forbidden" }));
		},
	);

	it.each([
		["absent", null],
		["manage-only", { ...facts.grant, grantType: "manage" }],
		["another Agent", { ...facts.grant, agentId: "agent_2" }],
		["another user", { ...facts.grant, principalId: "user_2" }],
		["application", { ...facts.grant, principalType: "application" }],
		["revoked", { ...facts.grant, revokedAt: facts.now }],
	] as const)("requires the current explicit use grant (%s)", (_, grant) => {
		expect(() =>
			requirePersonalApiTaskUseAuthorizationV1({ ...facts, grant }),
		).toThrow(expect.objectContaining({ code: "not_found" }));
	});

	it("rejects current disable facts, identity drift and corrupt scope/date facts", () => {
		for (const input of [
			{ ...facts, disabled: true },
			{
				...facts,
				user: { ...facts.user, accountStatus: "disabled" as const },
			},
		]) {
			expect(() => requirePersonalApiTaskUseAuthorizationV1(input)).toThrow(
				expect.objectContaining({ code: "forbidden" }),
			);
		}
		for (const input of [
			{
				...facts,
				user: { ...facts.user, authorizationRevision: "identity_2" },
			},
			{ ...facts, grant: { ...facts.grant, authorizationRevision: "use_2" } },
			{ ...facts, credential: { ...facts.credential, scopes: ["*"] } },
			{
				...facts,
				credential: { ...facts.credential, expiresAt: new Date(Number.NaN) },
			},
			{ ...facts, now: new Date(Number.NaN) },
		]) {
			expect(() => requirePersonalApiTaskUseAuthorizationV1(input)).toThrow(
				expect.objectContaining({ code: "unavailable" }),
			);
		}
	});
});
