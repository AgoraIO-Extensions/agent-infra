import { describe, expect, it, vi } from "vitest";
import {
	createPersonalApiCredentialUseCaseV1,
	PersonalApiCredentialErrorV1,
	type PersonalApiCredentialTransactionV1,
	parsePersonalApiCredentialIdV1,
	parsePersonalApiCredentialIssuanceV1,
	parsePersonalApiCredentialRequestV1,
	personalApiCredentialIssuanceDigestV1,
	requirePersonalApiCredentialFutureExpiryV1,
	requirePersonalApiUserActiveV1,
	requirePersonalApiUserEnabledV1,
	resolveCurrentPersonalApiUserV1,
} from "./personal-api-credentials.js";

const request = {
	userId: "user_alice",
	idempotencyKey: "issue.1",
	requestId: "request_1",
	traceId: "trace_1",
};
const user = {
	schemaVersion: 1,
	userId: request.userId,
	accountStatus: "active",
	organizationIds: ["org_1"],
	authorizationRevision: "revision_1",
} as const;
const sparseScopes = ["agent:read", "agent:use"];
sparseScopes.length = 3;

function useCase() {
	const transaction = {
		lockUserDisabled: vi.fn(async () => false),
		databaseTime: vi.fn(async () => new Date("2029-01-01T00:00:00.000Z")),
		lockIdempotency: vi.fn(async () => null),
		lockCredential: vi.fn(async () => null),
		insertCredential: vi.fn(
			async (
				input: Parameters<
					PersonalApiCredentialTransactionV1["insertCredential"]
				>[0],
			) => ({
				credentialId: input.credentialId,
				scopes: input.scopes,
				expiresAt: input.expiresAt,
				revokedAt: null,
				createdAt: "2029-01-01T00:00:00.000Z",
				lastUsedAt: null,
			}),
		),
		revokeCredential: vi.fn(async () => {
			throw new Error("Unused test method");
		}),
		completeIdempotency: vi.fn(async () => {}),
		recordAudit: vi.fn(async () => {}),
	} satisfies PersonalApiCredentialTransactionV1;
	const port = {
		execute: async <T>(
			work: (transaction: PersonalApiCredentialTransactionV1) => Promise<T>,
		) => work(transaction),
		recordAudit: vi.fn(async () => {}),
	};
	return {
		transaction,
		port,
		credentials: createPersonalApiCredentialUseCaseV1({
			transaction: port,
			userDirectory: { resolveUser: async () => user },
		}),
	};
}

describe("personal API credential policy", () => {
	it("snapshots the complete use-case command before its first asynchronous boundary", async () => {
		const { credentials, transaction } = useCase();
		const input = { scopes: ["agent:read"], expiresAt: "2030-01-01T00:00:00Z" };
		const issuance = credentials.issue(request, input);
		input.scopes[0] = "agent:create";
		input.expiresAt = "2031-01-01T00:00:00Z";
		const result = await issuance;
		expect(result.metadata.scopes).toEqual(["agent:read"]);
		expect(result.metadata.expiresAt).toBe("2030-01-01T00:00:00.000Z");
		expect(transaction.completeIdempotency).toHaveBeenCalledWith(
			request,
			"api.credential.issued",
			personalApiCredentialIssuanceDigestV1(
				parsePersonalApiCredentialIssuanceV1({
					scopes: ["agent:read"],
					expiresAt: "2030-01-01T00:00:00Z",
				}),
			),
			result.metadata.credentialId,
		);
	});

	it("withholds first-delivery material when the transaction commit fails", async () => {
		const { credentials, port, transaction } = useCase();
		port.execute = async (work) => {
			await work(transaction);
			throw new Error("SECRET_COMMIT_SENTINEL");
		};
		await expect(
			credentials.issue(request, { scopes: ["agent:read"], expiresAt: null }),
		).rejects.toMatchObject({
			code: "unavailable",
			message: "Personal API credential operation failed",
		});
		expect(
			transaction.insertCredential.mock.calls[0]?.[0].credentialHash,
		).toMatch(/^[a-f0-9]{64}$/);
		const audits = JSON.stringify([
			...transaction.recordAudit.mock.calls,
			...port.recordAudit.mock.calls,
		]);
		expect(audits).not.toContain("papi_");
		expect(audits).not.toContain("SECRET_COMMIT_SENTINEL");
		expect(port.recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: request.userId,
				credentialId: null,
				outcome: "failed",
				details: { reason: "unavailable" },
			}),
		);
	});
	it("snapshots and normalizes issuance for durable idempotency", () => {
		const input = {
			scopes: ["agent:use", "agent:read"],
			expiresAt: "2030-01-01T00:00:00.1Z",
		};
		const command = parsePersonalApiCredentialIssuanceV1(input);
		input.scopes[0] = "agent:create";
		input.expiresAt = "2031-01-01T00:00:00Z";
		expect(command).toEqual({
			scopes: ["agent:read", "agent:use"],
			expiresAt: "2030-01-01T00:00:00.100Z",
		});
		expect(Object.isFrozen(command)).toBe(true);
		expect(Object.isFrozen(command.scopes)).toBe(true);
		expect(personalApiCredentialIssuanceDigestV1(command)).toBe(
			personalApiCredentialIssuanceDigestV1(
				parsePersonalApiCredentialIssuanceV1({
					scopes: ["agent:read", "agent:use"],
					expiresAt: "2030-01-01T00:00:00.100Z",
				}),
			),
		);
	});

	it.each([
		{ scopes: [], expiresAt: null },
		{ scopes: ["agent:read", "agent:read"], expiresAt: null },
		{ scopes: ["system_admin"], expiresAt: null },
		{ scopes: sparseScopes, expiresAt: null },
		{ scopes: ["agent:read"] },
		{ scopes: ["agent:read"], expiresAt: "2030-02-30T00:00:00Z" },
		{ scopes: ["agent:read"], expiresAt: "2030-01-01T00:00:00+00:00" },
		{ scopes: ["agent:read"], expiresAt: "2030-01-01T00:00:00.0001Z" },
		{ scopes: ["agent:read"], expiresAt: null, userId: "other" },
		{ scopes: ["agent:read"], expiresAt: null, principal: { id: "other" } },
		{ scopes: ["agent:read"], expiresAt: null, applicationId: "other" },
		{ scopes: ["agent:read"], expiresAt: null, recipient: "other" },
		{ scopes: ["agent:read"], expiresAt: null, role: "system_admin" },
	])("rejects malformed or authority-bearing issuance", (input) => {
		expect(() => parsePersonalApiCredentialIssuanceV1(input)).toThrow(
			new PersonalApiCredentialErrorV1("invalid_input"),
		);
	});

	it("never evaluates caller accessors or proxy traps", () => {
		const getter = vi.fn(() => ["agent:read"]);
		const input = { expiresAt: null };
		Object.defineProperty(input, "scopes", { enumerable: true, get: getter });
		expect(() => parsePersonalApiCredentialIssuanceV1(input)).toThrow();
		const trap = vi.fn(() => {
			throw new Error("SECRET_SENTINEL");
		});
		expect(() =>
			parsePersonalApiCredentialIssuanceV1(new Proxy({}, { ownKeys: trap })),
		).toThrow();
		expect(getter).not.toHaveBeenCalled();
		expect(trap).not.toHaveBeenCalled();
	});

	it("uses current database time, including exact expiry and unavailable time", () => {
		const command = { expiresAt: "2030-01-01T00:00:00.000Z" };
		expect(() =>
			requirePersonalApiCredentialFutureExpiryV1(
				command,
				new Date("2029-12-31T23:59:59.999Z"),
			),
		).not.toThrow();
		expect(() =>
			requirePersonalApiCredentialFutureExpiryV1(
				command,
				new Date(command.expiresAt),
			),
		).toThrow(new PersonalApiCredentialErrorV1("invalid_input"));
		expect(() =>
			requirePersonalApiCredentialFutureExpiryV1(command, new Date(Number.NaN)),
		).toThrow(new PersonalApiCredentialErrorV1("unavailable"));
	});

	it("bounds stable IDs and trusted request correlation before persistence", () => {
		const parsed = parsePersonalApiCredentialRequestV1(request);
		expect(parsed).toEqual(request);
		expect(Object.isFrozen(parsed)).toBe(true);
		for (const credentialId of ["", "x\0y", "\ud800", "界".repeat(342)]) {
			expect(() => parsePersonalApiCredentialIdV1(credentialId)).toThrow();
		}
		for (const input of [
			{ ...request, idempotencyKey: "contains space" },
			{ ...request, idempotencyKey: "x".repeat(129) },
			{ ...request, traceId: "\ud800" },
			{ ...request, userId: "x\0y" },
			{ ...request, role: "system_admin" },
		])
			expect(() => parsePersonalApiCredentialRequestV1(input)).toThrow();
	});

	it("re-resolves stable current identity and rejects either disable authority", async () => {
		const directory = { resolveUser: vi.fn(async () => user) };
		const current = await resolveCurrentPersonalApiUserV1(
			directory,
			user.userId,
		);
		requirePersonalApiUserActiveV1(current);
		requirePersonalApiUserEnabledV1(false);
		expect(directory.resolveUser).toHaveBeenCalledWith(user.userId);
		expect(() => requirePersonalApiUserEnabledV1(true)).toThrow(
			new PersonalApiCredentialErrorV1("forbidden"),
		);
		expect(() =>
			requirePersonalApiUserActiveV1({ ...current, accountStatus: "disabled" }),
		).toThrow(new PersonalApiCredentialErrorV1("forbidden"));
	});

	it.each([
		undefined,
		{ resolveUser: async () => ({ ...user, userId: "user_other" }) },
		{ resolveUser: async () => ({ ...user, schemaVersion: 2 }) },
		{ resolveUser: async () => ({ ...user, authorizationRevision: "" }) },
		{
			resolveUser: async () => {
				throw new Error("SECRET_SENTINEL");
			},
		},
	])(
		"fails closed and sanitizes unavailable identity dependencies",
		async (directory) => {
			await expect(
				resolveCurrentPersonalApiUserV1(directory, user.userId),
			).rejects.toMatchObject({
				code: "unavailable",
				message: "Personal API credential operation failed",
			});
		},
	);

	it("refuses a missing current user without treating saved identity as authority", async () => {
		await expect(
			resolveCurrentPersonalApiUserV1(
				{ resolveUser: async () => null },
				user.userId,
			),
		).rejects.toMatchObject({ code: "forbidden" });
	});
});
