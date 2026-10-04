import { expect, it, vi } from "vitest";
import {
	type ApplicationApiCredentialTransactionV1,
	type ApplicationCredentialSavedReceiptV1,
	createApplicationApiCredentialIssuerV1,
} from "./application-api-credentials.js";
import type { PersonalApiCredentialMetadataV1 } from "./personal-api-credentials.js";

// Port-level race evidence; database rollback is covered by the Store integration suite.
it.each([2, 3, 4])(
	"refuses recipient revision changes at authority check %i",
	async (changeAt) => {
		let reads = 0;
		let receipt: ApplicationCredentialSavedReceiptV1 | null = null;
		let credential: PersonalApiCredentialMetadataV1 | null = null;
		const now = new Date().toISOString();
		const transaction: ApplicationApiCredentialTransactionV1 = {
			databaseTime: async () => new Date(),
			lockUserDisabled: async () => false,
			lockApplication: async () => ({
				responsibleUserId: "manager",
				status: "active",
			}),
			lockGrant: async () => ({
				applicationId: "app-1",
				principalType: "user",
				principalId: "recipient",
				authorizationRevision: "grant-v1",
				createdAt: now,
				revokedAt: null,
			}),
			lockReceipt: async () => receipt,
			lockActiveCredential: async () => credential,
			insertCredential: async (
				_applicationId,
				credentialId,
				_hash,
				command,
			) => {
				credential = {
					credentialId,
					scopes: command.scopes,
					expiresAt: command.expiresAt,
					createdAt: now,
					revokedAt: null,
					lastUsedAt: null,
				};
				return credential;
			},
			revokeCredential: async () => {
				throw new Error("Unexpected rotation");
			},
			saveReceipt: async (_request, saved) => {
				receipt = saved;
			},
			recordAudit: async () => {},
		};
		const delivery = {
			prepare: vi.fn(async () => {}),
			commit: vi.fn(async () => "accepted" as const),
			abort: vi.fn(),
		};
		const issuer = createApplicationApiCredentialIssuerV1({
			store: { execute: async (work) => work(transaction) },
			userDirectory: {
				resolveUser: async (userId) => ({
					schemaVersion: 1,
					userId,
					accountStatus: "active",
					organizationIds: [],
					authorizationRevision:
						userId === "recipient" && ++reads >= changeAt
							? "user-v2"
							: "user-v1",
				}),
			},
			delivery,
		});
		await expect(
			issuer.execute(
				{
					applicationId: "app-1",
					userId: "manager",
					requestId: "request-1",
					traceId: "trace-1",
					idempotencyKey: "issue-1",
				},
				{
					operation: "issue",
					recipient: { principalType: "user", principalId: "recipient" },
					scopes: ["agent:use"],
					expiresAt: null,
				},
			),
		).rejects.toMatchObject({ code: "forbidden" });
		expect(delivery.commit).not.toHaveBeenCalled();
		expect(delivery.prepare).toHaveBeenCalledTimes(changeAt === 2 ? 0 : 1);
		expect(delivery.abort).toHaveBeenCalledTimes(changeAt === 2 ? 0 : 1);
	},
);
