import {
	PostgresAgentConfigurationQueryV1,
	PostgresAgentManagementQueryV1,
	PostgresConversationQueryV1,
} from "@agent-infra/platform-store";
import { expect, it, vi } from "vitest";
import type { IdentityAdapter } from "./http/identity.js";
import { assemblePlatformNativeMetadataApiV1 } from "./native-metadata-assembly.js";

it.each([
	["absent", 404],
	["failed", 503],
	["foreign", 503],
	["revoked-absence", 404],
	["revoked-authentication", 401],
	["revoked-disabled", 404],
	["revoked-unknown", 503],
] as const)(
	"distinguishes trusted directory %s from unknown facts before metadata I/O",
	async (mode, status) => {
		const options = {
			databaseUrl: "postgres://invalid:invalid@127.0.0.1:1/invalid",
		};
		const query = new PostgresConversationQueryV1(options);
		const managementQuery = new PostgresAgentManagementQueryV1(options);
		const configurationQuery = new PostgresAgentConfigurationQueryV1(options);
		let revoked = false;
		const interleaved = mode.startsWith("revoked-");
		const original = new Request("https://platform.invalid/metadata", {
			headers: { cookie: "synthetic-original-browser-cookie" },
		});
		const resolve = vi.fn<IdentityAdapter["resolve"]>(async (request) => {
			expect(request).toBe(original);
			if (revoked && mode === "revoked-authentication") return null;
			return {
				schemaVersion: 1,
				userId: "alice",
				displayName: "Alice",
				accountStatus:
					revoked && mode === "revoked-disabled" ? "disabled" : "active",
				organizationIds: ["org"],
				roles: ["employee"],
				authorizationRevision: "browser-current",
			};
		});
		const resolveUser = vi.fn<NonNullable<IdentityAdapter["resolveUser"]>>(
			async () => {
				if (mode === "absent" || (revoked && mode === "revoked-absence"))
					return null;
				if (mode === "failed" || (revoked && mode === "revoked-unknown"))
					throw new Error("synthetic-private-directory-error");
				return {
					schemaVersion: 1,
					userId: mode === "foreign" ? "other-user" : "alice",
					accountStatus: "active",
					organizationIds: ["org"],
					authorizationRevision: "directory-current",
				};
			},
		);
		const scopeRead = vi
			.spyOn(query, "readNativeMetadataObjectScopeV1")
			.mockResolvedValue({
				schemaVersion: 1,
				principal: { kind: "user", id: "alice" },
				agentId: "agent",
				channelId: "web",
				conversationId: "conversation",
				executionId: "execution",
				sessionGeneration: 1,
				authorizationRevision: "original-revision",
			});
		const management = vi.spyOn(managementQuery, "getAgent").mockResolvedValue({
			schemaVersion: 1,
			agentId: "agent",
			applicationId: "application",
			name: "Agent",
			description: "Controlled fixture",
			sourceReference: "source",
			management: {
				schemaVersion: 1,
				applicationId: "application",
				agentId: "agent",
				applicantId: "alice",
				status: "available",
				revision: 1,
				approvalRevision: 1,
				decisionReason: null,
				serviceAvailability: "ready",
				desiredState: "running",
				workloadRevision: 1,
				fence: 1,
				ownerIds: ["alice"],
				availability: [],
				failureCode: null,
			},
		});
		const projection: Awaited<
			ReturnType<PostgresAgentConfigurationQueryV1["read"]>
		> = {
			outcome: "found",
			configuration: {
				agentId: "agent",
				revision: 1,
				source: {
					kind: "standard",
					templateId: "template",
					connectionEnabled: false,
				},
				ownerIds: ["alice"],
				availability: [],
				modelOptions: [],
				defaultModelOptionId: null,
				defaultReasoningLevel: null,
				environment: [],
				channelKinds: [],
				secrets: [],
			},
		};
		const configuration = vi
			.spyOn(configurationQuery, "read")
			.mockImplementation(async () => {
				revoked = true;
				return projection;
			});
		const send = vi.fn<typeof fetch>();
		const assembly = assemblePlatformNativeMetadataApiV1({
			identity: { resolve, resolveUser, hydrateUsers: async () => [] },
			query,
			managementQuery,
			configurationQuery,
			deployment: {
				workerId: "worker",
				apiRequestSourceRef: "api-instance",
				maxActiveReads: 1,
				workerOrigin: "https://worker.invalid",
				apiToWorkerToken: "synthetic-api-worker",
				workerToApiToken: "synthetic-worker-api",
				fetch: send,
			},
		});
		const respond = vi.fn(() => new Response("must not be delivered"));
		try {
			await expect(
				assembly.reads.read(
					original,
					{
						conversationId: "conversation",
						executionId: "execution",
						selector: "status",
						requestId: "request",
						traceId: "trace",
					},
					respond,
				),
			).rejects.toMatchObject({ status });
			expect(resolve.mock.calls.length).toBeGreaterThan(1);
			expect(resolveUser).toHaveBeenCalledWith("alice");
			expect(scopeRead).toHaveBeenCalledOnce();
			if (interleaved) {
				expect(management).toHaveBeenCalledOnce();
				expect(configuration).toHaveBeenCalledOnce();
				// Registry checks before/after SQL, then Core checks before/after Agent facts.
				expect(resolve).toHaveBeenCalledTimes(4);
			} else {
				expect(management).not.toHaveBeenCalled();
				expect(configuration).not.toHaveBeenCalled();
			}
			expect(send).not.toHaveBeenCalled();
			expect(respond).not.toHaveBeenCalled();
		} finally {
			assembly.close();
			await Promise.all([
				query.close(),
				managementQuery.close(),
				configurationQuery.close(),
			]);
			vi.restoreAllMocks();
		}
	},
);
