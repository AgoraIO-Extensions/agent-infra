import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	createPersonalApiAgentReadUseCaseV1,
	isPersonalApiAgentMetadataReadAllowedV1,
	type PersonalApiAgentReadAuditV1,
	type PersonalApiAgentReadTransactionV1,
} from "./personal-api-agent-read.js";

const material = `papi_${"a".repeat(43)}`;
const metadata = { requestId: "request-api-read", traceId: "trace-api-read" };

function harness() {
	const user = {
		schemaVersion: 1 as const,
		userId: "user-a",
		accountStatus: "active" as "active" | "disabled",
		organizationIds: ["org-a"],
		authorizationRevision: "identity-1",
	};
	const credential = {
		credentialId: "credential-used",
		principalType: "user" as const,
		principalId: "user-a",
		scopes: ["agent:read"],
		expiresAt: null as string | null,
		revokedAt: null as string | null,
		createdAt: "2026-10-01T00:00:00.000Z",
		lastUsedAt: null,
	};
	const committed: PersonalApiAgentReadAuditV1[] = [];
	let used = false;
	const operations: PersonalApiAgentReadTransactionV1 = {
		lockUsedCredential: vi.fn().mockResolvedValue(credential),
		lockUserDisabled: vi.fn().mockResolvedValue(false),
		lockAgentGrants: vi.fn().mockResolvedValue(undefined),
		databaseTime: vi.fn().mockResolvedValue(new Date("2026-10-01T00:00:01Z")),
		markCredentialUsed: vi.fn().mockImplementation(async () => {
			used = true;
		}),
		recordAudit: vi.fn().mockImplementation(async (event) => {
			committed.push(event);
		}),
	};
	const recordAgentReadAudit = vi.fn().mockImplementation(async (event) => {
		committed.push(event);
	});
	const resolveUser = vi
		.fn()
		.mockImplementation(async () => structuredClone(user));
	const useCase = createPersonalApiAgentReadUseCaseV1({
		transaction: {
			async executeAgentRead(work) {
				try {
					return await work(operations);
				} catch (error) {
					used = false;
					committed.length = 0;
					throw error;
				}
			},
			recordAgentReadAudit,
		},
		userDirectory: { resolveUser },
	});
	const read = vi.fn().mockResolvedValue({
		result: { items: ["agent-a"] },
		returnedAgentIds: ["agent-a"],
	});
	return {
		useCase,
		operations,
		read,
		credential,
		user,
		resolveUser,
		committed,
		recordAgentReadAudit,
		wasUsed: () => used,
	};
}

describe("used personal credential Agent metadata reads", () => {
	it("checks the actual material and stable current user, locks grants, and commits audit before delivery", async () => {
		const h = harness();
		expect(await h.useCase.readAgents(metadata, material, h.read)).toEqual({
			items: ["agent-a"],
		});
		expect(h.operations.lockUsedCredential).toHaveBeenCalledExactlyOnceWith(
			createHash("sha256").update(material).digest("hex"),
		);
		expect(h.operations.lockUserDisabled).toHaveBeenCalledWith("user-a");
		expect(h.operations.lockAgentGrants).toHaveBeenCalledOnce();
		expect(h.resolveUser).toHaveBeenCalledTimes(2);
		expect(h.read).toHaveBeenCalledWith(h.user);
		expect(h.wasUsed()).toBe(true);
		expect(h.committed).toEqual([
			{
				...metadata,
				userId: "user-a",
				credentialId: "credential-used",
				action: "api.agent.metadata.read",
				outcome: "succeeded",
				details: {
					returnedAgentIds: ["agent-a"],
					grantFilter: "manage_or_use",
				},
			},
		]);
		expect(JSON.stringify(h.committed)).not.toContain(material);
		expect(JSON.stringify(h.committed)).not.toContain(
			createHash("sha256").update(material).digest("hex"),
		);
	});

	it.each([
		"revoked",
		"expired",
		"missing-read-scope",
		"platform-disabled",
		"directory-disabled",
	])(
		"rejects %s without consulting an alternate credential or browser identity",
		async (condition) => {
			const h = harness();
			let code = "forbidden";
			if (condition === "revoked") {
				h.credential.revokedAt = "2026-10-01T00:00:00Z";
				code = "authentication_required";
			}
			if (condition === "expired") {
				h.credential.expiresAt = "2026-10-01T00:00:01Z";
				code = "authentication_required";
			}
			if (condition === "missing-read-scope")
				h.credential.scopes = ["agent:use"];
			if (condition === "platform-disabled")
				vi.mocked(h.operations.lockUserDisabled).mockResolvedValue(true);
			if (condition === "directory-disabled") h.user.accountStatus = "disabled";
			await expect(
				h.useCase.readAgents(metadata, material, h.read),
			).rejects.toMatchObject({ code });
			expect(h.read).not.toHaveBeenCalled();
			expect(h.wasUsed()).toBe(false);
			expect(h.committed[0]).toMatchObject({
				userId: "user-a",
				credentialId: "credential-used",
				outcome: "rejected",
				details: { reason: code },
			});
			if (condition === "platform-disabled")
				expect(h.resolveUser).not.toHaveBeenCalled();
		},
	);

	it.each(["malformed", "unknown"])(
		"does not invent an actor or credential reference for %s material",
		async (condition) => {
			const h = harness();
			if (condition === "unknown")
				vi.mocked(h.operations.lockUsedCredential).mockResolvedValue(null);
			await expect(
				h.useCase.readAgents(
					metadata,
					condition === "malformed" ? "self-reported-id" : material,
					h.read,
				),
			).rejects.toMatchObject({ code: "authentication_required" });
			expect(h.read).not.toHaveBeenCalled();
			expect(h.committed[0]).toMatchObject({
				userId: null,
				credentialId: null,
			});
		},
	);

	it.each([
		"exception",
		"different-user",
		"revision-change",
		"disabled-during-read",
	])("fails closed for current directory %s", async (condition) => {
		const h = harness();
		let code = "unavailable";
		if (condition === "exception")
			h.resolveUser.mockRejectedValue(
				new Error(`private upstream ${material}`),
			);
		if (condition === "different-user")
			h.resolveUser.mockResolvedValue({ ...h.user, userId: "user-b" });
		if (condition === "revision-change")
			h.read.mockImplementation(async () => {
				h.user.authorizationRevision = "identity-2";
				return { result: "private", returnedAgentIds: ["agent-a"] };
			});
		if (condition === "disabled-during-read") {
			code = "forbidden";
			h.read.mockImplementation(async () => {
				h.user.accountStatus = "disabled";
				return { result: "private", returnedAgentIds: ["agent-a"] };
			});
		}
		await expect(
			h.useCase.readAgents(metadata, material, h.read),
		).rejects.toMatchObject({
			code,
			message: "Personal API credential operation failed",
		});
		expect(h.wasUsed()).toBe(false);
		expect(h.committed.some((event) => event.outcome === "succeeded")).toBe(
			false,
		);
		expect(JSON.stringify(h.committed)).not.toContain(material);
	});

	it("rechecks DB expiry after projection so a credential expiring during the read delivers no page", async () => {
		const h = harness();
		h.credential.expiresAt = "2026-10-01T00:00:02Z";
		vi.mocked(h.operations.databaseTime)
			.mockResolvedValueOnce(new Date("2026-10-01T00:00:01Z"))
			.mockResolvedValueOnce(new Date("2026-10-01T00:00:02Z"));
		await expect(
			h.useCase.readAgents(metadata, material, h.read),
		).rejects.toMatchObject({ code: "authentication_required" });
		expect(h.read).toHaveBeenCalledOnce();
		expect(h.wasUsed()).toBe(false);
	});

	it("audit failure rolls back last-used and withholds a legitimate result", async () => {
		const h = harness();
		vi.mocked(h.operations.recordAudit).mockRejectedValue(
			new Error(`db private ${material}`),
		);
		await expect(
			h.useCase.readAgents(metadata, material, h.read),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(h.read).toHaveBeenCalledOnce();
		expect(h.wasUsed()).toBe(false);
		expect(h.committed).toEqual([
			{
				...metadata,
				userId: "user-a",
				credentialId: "credential-used",
				action: "api.agent.metadata.read",
				outcome: "failed",
				details: { reason: "unavailable" },
			},
		]);
	});

	it("refusal audit failure keeps the original credential refusal", async () => {
		const h = harness();
		h.credential.revokedAt = "2026-10-01T00:00:00Z";
		h.recordAgentReadAudit.mockRejectedValue(new Error("audit unavailable"));
		await expect(
			h.useCase.readAgents(metadata, material, h.read),
		).rejects.toMatchObject({ code: "authentication_required" });
		expect(h.read).not.toHaveBeenCalled();
	});

	it("allows either current grant and rejects Owner/admin/organization labels", () => {
		for (const grants of [["manage"], ["use"], ["manage", "use"]])
			expect(isPersonalApiAgentMetadataReadAllowedV1(grants)).toBe(true);
		for (const grants of [
			[],
			["owner"],
			["administrator"],
			["organization"],
			["agent:read"],
		])
			expect(isPersonalApiAgentMetadataReadAllowedV1(grants)).toBe(false);
	});
});
