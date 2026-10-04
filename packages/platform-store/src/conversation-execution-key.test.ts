import type {
	ConversationExecutionAuthorityV1,
	CurrentTaskApplicationV1,
	CurrentTaskUserV1,
	PersonalApiTaskAdmissionAuthorityV1,
	TaskUserDirectoryV1,
} from "@agent-infra/platform-core";
import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
	agentConfigurationConformanceRecordV1,
	agentConfigurationCustomImageRecordV1,
} from "../../platform-core/src/agent-configuration.conformance.ts";
import { currentConversationExecutionRelayKeyBindingV1 as selectKey } from "./conversation-execution-key.js";

const identity: CurrentTaskUserV1 = {
	schemaVersion: 1,
	userId: "user-1",
	accountStatus: "active",
	organizationIds: ["org-1"],
	authorizationRevision: "identity-1",
};
const apiAuthority: PersonalApiTaskAdmissionAuthorityV1 = {
	schemaVersion: 1,
	principal: { kind: "user", id: identity.userId },
	credentialId: "credential-1",
	credentialHash: "a".repeat(64),
	agentId: agentConfigurationConformanceRecordV1.agentId,
	channelId: "api",
	operation: "agent:use",
	identityRevision: "identity-1",
	useGrantRevision: "grant-1",
};

function authority(channelId = "web"): ConversationExecutionAuthorityV1 {
	return {
		schemaVersion: 1,
		actorId: identity.userId,
		agentId: apiAuthority.agentId,
		channelId,
		authorizationRevision: "access-1",
		supportsSupplementaryInstruction: false,
		taskBoundary: {
			schemaVersion: 1,
			principal: { kind: "user", id: identity.userId },
			agentId: apiAuthority.agentId,
			channelId,
			identityRevision: "identity-1",
			agentAuthorizationRevision: "access-1",
			accessSources:
				channelId === "api" || channelId === "api:user"
					? [{ kind: "api-use", useGrantRevision: "grant-1" }]
					: [{ kind: "organization", organizationId: "org-1" }],
		},
	};
}

function harness(
	options: {
		source?: "standard" | "custom";
		application?: CurrentTaskApplicationV1;
		revision?: string;
		missingKey?: boolean;
		disabled?: boolean;
		revokedGrant?: boolean;
		expiredCredential?: boolean;
		credentialExpiresAt?: Date;
		clocks?: Date[];
		unknownError?: boolean;
		wrongIsolation?: boolean;
		users?: CurrentTaskUserV1[];
	} = {},
) {
	const queries: { statement: string; values: unknown[] }[] = [];
	let clockReads = 0;
	const transaction = (async (
		strings: TemplateStringsArray,
		...values: unknown[]
	) => {
		const statement = strings.join("?").replace(/\s+/g, " ").trim();
		queries.push({ statement, values });
		if (options.unknownError) throw new Error("private dependency payload");
		if (statement === "show transaction_isolation")
			return [
				{
					transaction_isolation: options.wrongIsolation
						? "repeatable read"
						: "read committed",
				},
			];
		if (statement.includes("from platform.agents agent"))
			return [
				{
					current_configuration_revision: String(
						agentConfigurationConformanceRecordV1.revision,
					),
					authorization_revision: options.revision ?? "access-1",
					configuration:
						options.source === "custom"
							? agentConfigurationCustomImageRecordV1
							: agentConfigurationConformanceRecordV1,
				},
			];
		if (statement.startsWith("lock table")) return [];
		if (statement.includes("from platform.platform_applications application"))
			return options.application ? [{ application: options.application }] : [];
		if (statement.includes("from platform.platform_user_disables"))
			return options.disabled ? [{ user_id: identity.userId }] : [];
		if (statement.includes("where credential_hash"))
			return [{ id: apiAuthority.credentialId }];
		if (statement.includes("from platform.platform_api_credentials"))
			return [
				{
					id: apiAuthority.credentialId,
					credential_hash: apiAuthority.credentialHash,
					principal_type: options.application ? "application" : "user",
					principal_id: identity.userId,
					scopes: ["agent:use"],
					expires_at: options.expiredCredential
						? new Date(0)
						: (options.credentialExpiresAt ?? null),
					revoked_at: null,
				},
			];
		if (statement.includes("from platform.agent_principal_grants"))
			return options.revokedGrant
				? []
				: [
						{
							agent_id: apiAuthority.agentId,
							principal_type: options.application ? "application" : "user",
							principal_id: identity.userId,
							grant_type: "use",
							authorization_revision: apiAuthority.useGrantRevision,
							revoked_at: null,
						},
					];
		if (statement.includes("clock_timestamp()"))
			return [
				{
					now:
						options.clocks?.[clockReads++] ?? new Date("2026-10-02T00:00:00Z"),
				},
			];
		if (statement.includes("from platform.relay_key_subjects"))
			return options.missingKey
				? []
				: [{ key_id: "ciphertext-1", key_version: "7" }];
		throw new Error(
			`Unrecognized controlled transaction statement: ${statement}`,
		);
	}) as unknown as postgres.TransactionSql;
	let reads = 0;
	const userDirectory: TaskUserDirectoryV1 = {
		async resolveUser() {
			return options.users?.[reads++] ?? identity;
		},
	};
	return { transaction, userDirectory, queries };
}

describe("Execution Key selection on the caller's transaction", () => {
	it.each([
		["web", "web", "personal", identity.userId],
		["wecom_app:binding-1", "wecom", "personal", identity.userId],
		["api", "platform-api", "agent-default", apiAuthority.agentId],
		["eval", "eval", "agent-default", apiAuthority.agentId],
	] as const)(
		"freezes trusted %s purpose and exact version",
		async (channel, executionSource, purpose, subjectId) => {
			const h = harness();
			expect(
				await selectKey(h.transaction, {
					authority: authority(channel),
					userDirectory: h.userDirectory,
					...(channel === "api"
						? { personalApiAdmissionAuthority: apiAuthority }
						: {}),
				}),
			).toEqual({
				executionSource,
				relayKeyBinding: {
					purpose,
					subjectId,
					keyId: "ciphertext-1",
					keyVersion: 7,
				},
			});
			const selection = h.queries.filter((q) =>
				q.statement.includes("from platform.relay_key_subjects"),
			);
			expect(selection).toHaveLength(1);
			expect(selection[0]?.values).toEqual([purpose, subjectId]);
			expect(
				h.queries.some((q) => q.statement.includes("for share of s")),
			).toBe(true);
		},
	);

	it("keeps custom execution Key-free without resolving a personal identity", async () => {
		const h = harness({ source: "custom" });
		expect(
			await selectKey(h.transaction, {
				authority: authority(),
				userDirectory: undefined,
			}),
		).toEqual({ executionSource: null, relayKeyBinding: null });
		expect(
			h.queries.some((q) => q.statement.includes("relay_key_subjects")),
		).toBe(false);
	});

	it.each(["web", "api"])(
		"does not fall back when %s Key is missing",
		async (channel) => {
			const h = harness({ missingKey: true });
			expect(
				await selectKey(h.transaction, {
					authority: authority(channel),
					userDirectory: h.userDirectory,
					...(channel === "api"
						? { personalApiAdmissionAuthority: apiAuthority }
						: {}),
				}),
			).toBeNull();
			expect(
				h.queries.filter((q) =>
					q.statement.includes("from platform.relay_key_subjects"),
				),
			).toHaveLength(1);
		},
	);

	it.each([{ disabled: true }, { revision: "access-2" }])(
		"rejects current local authority change %j before reading Key",
		async (options) => {
			const h = harness(options);
			expect(
				await selectKey(h.transaction, {
					authority: authority(),
					userDirectory: h.userDirectory,
				}),
			).toBeNull();
			expect(
				h.queries.some((q) => q.statement.includes("relay_key_subjects")),
			).toBe(false);
		},
	);

	it.each([{ revokedGrant: true }, { expiredCredential: true }])(
		"reuses real personal API policy for current %j",
		async (options) => {
			const h = harness(options);
			expect(
				await selectKey(h.transaction, {
					authority: authority("api"),
					userDirectory: h.userDirectory,
					personalApiAdmissionAuthority: apiAuthority,
				}),
			).toBeNull();
			expect(
				h.queries.some((q) => q.statement.includes("relay_key_subjects")),
			).toBe(false);
		},
	);

	it("rejects API expiry while waiting for Key or directory, after initially valid admission", async () => {
		const h = harness({
			credentialExpiresAt: new Date("2026-10-02T00:00:01Z"),
			clocks: [
				new Date("2026-10-02T00:00:00Z"),
				new Date("2026-10-02T00:00:02Z"),
			],
		});
		expect(
			await selectKey(h.transaction, {
				authority: authority("api"),
				userDirectory: h.userDirectory,
				personalApiAdmissionAuthority: apiAuthority,
			}),
		).toBeNull();
		expect(
			h.queries.filter((q) => q.statement.includes("relay_key_subjects")),
		).toHaveLength(1);
		expect(
			h.queries.filter((q) => q.statement.includes("clock_timestamp()")),
		).toHaveLength(2);
	});

	it("rejects identity loss after the Key read", async () => {
		const h = harness({
			users: [identity, { ...identity, accountStatus: "disabled" }],
		});
		expect(
			await selectKey(h.transaction, {
				authority: authority(),
				userDirectory: h.userDirectory,
			}),
		).toBeNull();
	});

	it.each(["api:user", "api:application"])(
		"cannot bypass explicit API grant using %s",
		async (channel) => {
			const h = harness();
			await expect(
				selectKey(h.transaction, {
					authority: authority(channel),
					userDirectory: h.userDirectory,
				}),
			).rejects.toMatchObject({ code: "unavailable" });
			expect(
				h.queries.some((q) => q.statement.includes("relay_key_subjects")),
			).toBe(false);
		},
	);

	it("refuses a missing trusted directory or API authority", async () => {
		for (const channel of ["web", "api"]) {
			const h = harness();
			await expect(
				selectKey(h.transaction, {
					authority: authority(channel),
					userDirectory: undefined,
				}),
			).rejects.toMatchObject({ code: "unavailable" });
		}
	});

	it.each([{ unknownError: true }, { wrongIsolation: true }])(
		"fails closed with a fixed error for %j",
		async (options) => {
			const h = harness(options);
			await expect(
				selectKey(h.transaction, {
					authority: authority(),
					userDirectory: h.userDirectory,
				}),
			).rejects.toMatchObject({
				code: "unavailable",
				message: "Conversation persistence is unavailable",
			});
		},
	);
});

it.each(["api", "api:application"] as const)(
	"freezes an application %s Agent-default version without person/owner Key",
	async (channelId) => {
		const application: CurrentTaskApplicationV1 = {
			schemaVersion: 1,
			applicationId: identity.userId,
			status: "active",
			authorizationRevision: "application-1",
			useGrant: {
				principal: { kind: "application", id: identity.userId },
				grantType: "use",
				agentId: apiAuthority.agentId,
				authorizationRevision: "grant-1",
				revoked: false,
			},
		};
		const base = authority(channelId);
		if (!base.taskBoundary) throw new Error("Expected original Task boundary");
		const h = harness({ application, disabled: true });
		const result = await selectKey(h.transaction, {
			authority: {
				...base,
				taskBoundary: {
					...base.taskBoundary,
					principal: { kind: "application", id: identity.userId },
					identityRevision: "application-1",
					accessSources: [{ kind: "api-use", useGrantRevision: "grant-1" }],
				},
			},
			userDirectory: undefined,
			personalApiAdmissionAuthority: {
				...apiAuthority,
				principal: { kind: "application", id: identity.userId },
				channelId,
				identityRevision: "application-1",
			},
		});
		expect(result?.relayKeyBinding).toMatchObject({
			purpose: "agent-default",
			subjectId: apiAuthority.agentId,
			keyVersion: 7,
		});
		const keyReads = h.queries.filter((q) =>
			q.statement.includes("from platform.relay_key_subjects"),
		);
		expect(keyReads[0]?.values).toEqual([
			"agent-default",
			apiAuthority.agentId,
		]);
	},
);
