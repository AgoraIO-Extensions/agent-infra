import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
	type ActionDefinition,
	ConnectionApplicationService,
	ConnectionError,
	ConnectionRecoveryService,
	type ConnectionRepository,
	type CredentialForExecution,
	canonicalHash,
	canonicalHashForVersion,
	canonicalHashMatches,
	canonicalJson,
	canonicalJsonVersions,
	decideReconnectAuthorization,
	deriveConnectionIdentitySubjectHash,
	type GitHubExecutor,
	type GitHubOAuthProvider,
	type GitHubReconciler,
	type InvocationContext,
	normalizeSharedScopeDisplayName,
	ProviderExecutorRouter,
	type ReconciliationJob,
	type StoredCall,
} from "./index";

const actions: ActionDefinition[] = [
	{
		description: "Read repository",
		effect: "READ",
		id: "github.getRepository@v1",
		inputSchema: {
			additionalProperties: false,
			properties: { repository: { minLength: 1, type: "string" } },
			required: ["repository"],
			type: "object",
		},
		name: "github.getRepository",
		requiredScopes: [],
	},
	{
		description: "Create pull request",
		effect: "WRITE",
		id: "github.createPullRequest@v1",
		inputSchema: {
			additionalProperties: false,
			properties: {
				base: { minLength: 1, type: "string" },
				head: { minLength: 1, type: "string" },
				repository: { minLength: 1, type: "string" },
				title: { minLength: 1, type: "string" },
			},
			required: ["repository", "head", "base", "title", "idempotencyKey"],
			type: "object",
		},
		name: "github.createPullRequest",
		requiredScopes: [],
	},
];

describe("SharedScope display names", () => {
	it("normalizes valid names and rejects empty or oversized names", () => {
		expect(normalizeSharedScopeDisplayName("  Release Engineering  ")).toBe(
			"Release Engineering",
		);
		expect(() => normalizeSharedScopeDisplayName("   ")).toThrowError(
			ConnectionError,
		);
		expect(() => normalizeSharedScopeDisplayName("x".repeat(121))).toThrowError(
			ConnectionError,
		);
	});
});

describe("Connection identity authority", () => {
	it("derives a stable environment-bound LDAP subject hash for administrator bootstrap", () => {
		const input = {
			environment: "https://connection.example/",
			identity: { issuer: "urn:company:ldap", subject: "employee-123" },
			key: Buffer.alloc(32, 17),
		};
		const first = deriveConnectionIdentitySubjectHash(input);
		expect(first).toMatch(/^v1:[a-f0-9]{64}$/);
		expect(deriveConnectionIdentitySubjectHash(input)).toBe(first);
		expect(
			deriveConnectionIdentitySubjectHash({
				...input,
				environment: "https://other-connection.example/",
			}),
		).not.toBe(first);
	});
});

const direct: InvocationContext = {
	connectionId: "connection-alice",
	consumerId: "consumer-codex",
	credentialVersionId: "credential-1",
	grantId: "grant-alice",
	instanceId: "codex-desktop",
	principalId: "alice",
	providerId: "github",
	providerReleaseId: "github-release-v1",
};
const delegated: InvocationContext = {
	...direct,
	actorKey: "agent-platform-agent",
	instanceId: "agent-platform",
};

class MemoryRepository implements ConnectionRepository {
	readonly calls: StoredCall[] = [];
	readonly reconciliationJobs: ReconciliationJob[] = [];
	readonly rescheduledCallIds: string[] = [];
	private readonly activeReconciliationJobs = new Map<
		string,
		ReconciliationJob
	>();
	storedOAuthCredential?: {
		accessToken: string;
		displayName: string;
		externalAccount: string;
		principalId: string;
	};
	storedSharedOAuthCredential?: {
		accessToken: string;
		actorPrincipalId: string;
		displayName: string;
		externalAccount: string;
		grantedScopes: readonly string[];
		sharedScopeId: string;
	};
	private sequence = 0;
	private oauthTransactions = new Map<
		string,
		{
			codeVerifier: string;
			principalId: string;
			redirectUri: string;
			sharedScopeId?: string;
		}
	>();
	private callInputs = new Map<string, Record<string, unknown>>();
	private callActionVersionIds = new Map<string, string>();
	private leaseSequence = 0;
	directInvocation = direct;
	failSuccessfulFinalization = false;
	rejectNextDispatch = false;
	async ensurePrincipal() {}
	async authorizeConnectionAdministration() {
		return false;
	}
	async isConnectionAdministrator() {
		return false;
	}
	async grantConnectionAdministrator() {}
	async grantSharedScopePrincipal() {}
	async listConnectionAdministratorCandidates() {
		return [];
	}
	async listConnectionAdministrators() {
		return [];
	}
	async revokeConnectionAdministrator() {}
	async revokeSharedScopePrincipal() {}
	async renameSharedScope() {}
	async sharedGithubAdministration() {
		return { principals: [], scopes: [] };
	}
	async createSharedScope() {
		return { sharedScopeId: "shared-scope-test" };
	}
	async storeSharedGithubOAuthCredential(input: {
		accessToken: string;
		actorPrincipalId: string;
		displayName: string;
		externalAccount: string;
		grantedScopes: readonly string[];
		sharedScopeId: string;
	}) {
		this.storedSharedOAuthCredential = input;
		return { connectionId: "connection-shared-test" };
	}
	async createCall(input: {
		action: string;
		actionVersionId?: string;
		argsHash: string;
		idempotencyKey?: string;
		input: Record<string, unknown>;
		invocation: InvocationContext;
	}) {
		const existing = input.idempotencyKey
			? await this.findIdempotentCall({
					action: input.action,
					idempotencyKey: input.idempotencyKey,
					invocation: input.invocation,
				})
			: undefined;
		if (existing) return { call: existing, created: false };
		this.sequence += 1;
		const call: StoredCall = {
			action: input.action,
			argsHash: input.argsHash,
			callId: `call-${this.sequence}`,
			connectionId: input.invocation.connectionId,
			createdAt: "2026-01-01T00:00:00.000Z",
			grantId: input.invocation.grantId,
			idempotencyKey: input.idempotencyKey,
			invocation: input.invocation,
			status: "AUTHORIZED",
		};
		this.calls.push(call);
		this.callInputs.set(call.callId, input.input);
		this.callActionVersionIds.set(
			call.callId,
			input.actionVersionId ??
				actions.find((action) => action.name === input.action)?.id ??
				input.action,
		);
		return { call, created: true };
	}
	async claimReconciliationJob() {
		const pending = this.reconciliationJobs.shift();
		if (!pending) return undefined;
		const job = { ...pending, leaseId: `lease-${++this.leaseSequence}` };
		this.activeReconciliationJobs.set(job.leaseId, job);
		return job;
	}
	async completeReconciliationJob(input: {
		callId: string;
		leaseId: string;
		result: Record<string, unknown>;
	}) {
		const job = this.activeReconciliationJobs.get(input.leaseId);
		if (!job || job.callId !== input.callId) return;
		this.activeReconciliationJobs.delete(input.leaseId);
		await this.setCallResult({
			callId: input.callId,
			result: input.result,
			status: "SUCCEEDED",
		});
	}
	async confirmCurrentConsumerAuthorization() {
		return { grantId: "grant-authorized" };
	}
	async createCurrentConsumerAuthorizationPreview(): Promise<never> {
		throw new Error(
			"Authorization preview is not used by this test repository",
		);
	}
	async publishConsumerDeclaration() {
		return { declarationId: "declaration-test" };
	}
	async disconnectConnection() {}
	async disconnectSharedConnection() {}
	async createOAuthTransaction(input: {
		codeVerifier: string;
		principalId: string;
		redirectUri: string;
		sharedScopeId?: string;
		state: string;
	}) {
		this.oauthTransactions.set(input.state, input);
	}
	async consumeOAuthTransaction(state: string) {
		const transaction = this.oauthTransactions.get(state);
		if (!transaction)
			throw new ConnectionError(
				"INVALID_REQUEST",
				"OAuth state is invalid, expired, or already consumed",
			);
		this.oauthTransactions.delete(state);
		return transaction;
	}
	async storeGithubOAuthCredential(input: {
		accessToken: string;
		displayName: string;
		externalAccount: string;
		principalId: string;
	}) {
		this.storedOAuthCredential = input;
		return { connectionId: "connection-oauth" };
	}
	async storeProviderCredential(input: {
		accessToken: string;
		displayName: string;
		externalAccount: string;
		principalId: string;
	}) {
		this.storedOAuthCredential = input;
		return { connectionId: "connection-provider" };
	}
	async findIdempotentCall(input: {
		action: string;
		idempotencyKey: string;
		invocation: InvocationContext;
	}) {
		return this.calls.find(
			(call) =>
				call.idempotencyKey === input.idempotencyKey &&
				call.invocation.principalId === input.invocation.principalId &&
				call.invocation.consumerId === input.invocation.consumerId &&
				call.invocation.actorKey === input.invocation.actorKey,
		);
	}
	async getCredential(
		_invocation: InvocationContext,
	): Promise<CredentialForExecution> {
		return { accessToken: "test-secret" };
	}
	async getOverview() {
		return {
			actions,
			calls: [],
			connections: [],
			consumers: [],
			grants: [],
			principal: { displayName: "Alice", id: "alice" },
		};
	}
	async listAuthorizedActions() {
		return actions;
	}
	async listAuthorizedConnections() {
		return [
			{
				actionVersionIds: actions.map((action) => action.id),
				displayName: "Alice GitHub",
				externalAccount: "alice-github",
				id: direct.connectionId,
				ownerType: "PERSONAL" as const,
				providerId: "github",
				requiresReconnect: false,
				status: "ACTIVE" as const,
			},
		];
	}
	async resolveDelegatedWorkload(_workload?: string, _actorKey?: string) {
		return delegated;
	}
	async resolveDelegatedWorkloads(_workload?: string, _actorKey?: string) {
		return [delegated];
	}
	async resolveDirectSession() {
		return this.directInvocation;
	}
	async resolveDirectIdentity() {
		return direct;
	}
	async resolveDirectIdentities() {
		return [direct];
	}
	async setCallResult(input: {
		callId: string;
		result?: Record<string, unknown>;
		status: StoredCall["status"];
	}) {
		if (input.status === "SUCCEEDED" && this.failSuccessfulFinalization) {
			this.failSuccessfulFinalization = false;
			throw new Error("database finalization failed");
		}
		const call = this.calls.find((entry) => entry.callId === input.callId);
		if (call) {
			call.status = input.status;
			call.result = input.result;
			if (input.status === "UNCERTAIN") {
				this.reconciliationJobs.push({
					action: call.action,
					actionVersionId:
						this.callActionVersionIds.get(call.callId) ?? call.action,
					callId: call.callId,
					input: this.callInputs.get(call.callId) ?? {},
					invocation: call.invocation,
					leaseId: "pending",
				});
			}
		}
	}
	async startDispatch() {
		if (this.rejectNextDispatch) {
			throw new ConnectionError(
				"FORBIDDEN",
				"Connection authorization is no longer active",
			);
		}
	}
	async rescheduleReconciliationJob(input: {
		callId: string;
		leaseId: string;
		reason: string;
	}) {
		const job = this.activeReconciliationJobs.get(input.leaseId);
		if (!job || job.callId !== input.callId) return;
		this.activeReconciliationJobs.delete(input.leaseId);
		this.rescheduledCallIds.push(input.callId);
	}
	async revokeGrant() {}
	async verifyInvocation() {}
}

describe("Connection application service", () => {
	it("requires reconfirmation unless reconnect authorization proof matches exactly", () => {
		const current = {
			actionVersionIds: actions.map((action) => action.id),
			actorKey: "",
			confirmedActionSetDigest: canonicalHash(actions),
			consentId: "consent-1",
			consumerDeclarationId: "declaration-1",
			credentialScopeDigest: "scope-digest",
			externalAccountFingerprint: "account-fingerprint",
			providerId: "github",
			providerReleaseId: "github-release-1",
			rootStatus: "ACTIVE",
			sharedEligibilityPathHash: null,
		};
		const target = {
			actions,
			consumerDeclarationId: "declaration-1",
			credentialScopeDigest: "scope-digest",
			externalAccountFingerprint: "account-fingerprint",
			providerId: "github",
			providerReleaseId: "github-release-1",
			sharedEligibilityPathHash: null,
		};

		expect(decideReconnectAuthorization({ current, target })).toBe(
			"REPLACE_GRANT",
		);
		for (const changed of [
			{ current: { ...current, actorKey: "agent-1" }, target },
			{ current: { ...current, consentId: null }, target },
			{ current: { ...current, rootStatus: "TERMINATED" }, target },
			{
				current: { ...current, providerReleaseId: "github-release-0" },
				target,
			},
			{
				current: { ...current, credentialScopeDigest: "old-scope-digest" },
				target,
			},
			{
				current: {
					...current,
					confirmedActionSetDigest: "old-action-digest",
				},
				target,
			},
			{ current, target: undefined },
		]) {
			expect(decideReconnectAuthorization(changed)).toBe(
				"REQUIRE_RECONFIRMATION",
			);
		}
	});

	it("matches the published connection-json-v2 interoperability vectors", async () => {
		const vectors = JSON.parse(
			await readFile(
				resolve(
					import.meta.dirname,
					"../../../docs/architecture/connection-json-v2-vectors.json",
				),
				"utf8",
			),
		) as {
			version: string;
			vectors: Array<{
				canonicalJson: string;
				hash: string;
				input: unknown;
			}>;
		};

		expect(vectors.version).toBe(canonicalJsonVersions.current);
		for (const vector of vectors.vectors) {
			expect(canonicalJson(vector.input)).toBe(vector.canonicalJson);
			expect(canonicalHash(vector.input)).toBe(vector.hash);
		}
	});

	it("canonicalizes security-relevant JSON with a versioned deterministic encoding", () => {
		expect(canonicalJson({ b: [true, null], a: { y: 2, x: 1 } })).toBe(
			'{"a":{"x":1,"y":2},"b":[true,null]}',
		);
		expect(canonicalHash({ b: 2, a: 1 })).toBe(canonicalHash({ a: 1, b: 2 }));
		expect(canonicalHash({ a: 1 })).toMatch(
			/^connection-json-v2:[0-9a-f]{64}$/,
		);
		expect(canonicalHash(["a", "b"])).not.toBe(canonicalHash(["b", "a"]));
		expect(() => canonicalJson({ value: Number.NaN })).toThrow(ConnectionError);
		expect(() => canonicalJson({ value: undefined })).toThrow(ConnectionError);
	});

	it("uses Unicode-normalized v2 hashes and reads legacy v1 hashes", () => {
		const composed = String.fromCodePoint(0x00e9);
		const decomposed = `e${String.fromCodePoint(0x0301)}`;
		const bmp = String.fromCodePoint(0xe000);
		const supplementary = String.fromCodePoint(0x10000);
		const legacyInput = { label: decomposed };
		const legacyHash = canonicalHashForVersion(
			canonicalJsonVersions.legacy,
			legacyInput,
		);

		expect(canonicalJson({ [decomposed]: decomposed })).toBe(
			`{"${composed}":"${composed}"}`,
		);
		expect(
			canonicalJson({ [supplementary]: "supplementary", [bmp]: "bmp" }),
		).toBe(`{"${bmp}":"bmp","${supplementary}":"supplementary"}`);
		expect(canonicalHash({ label: composed })).toBe(
			canonicalHash({ label: decomposed }),
		);
		expect(canonicalJson({ [decomposed]: decomposed, b: [true, null] })).toBe(
			'{"b":[true,null],"é":"é"}',
		);
		expect(canonicalHash({ [decomposed]: decomposed, b: [true, null] })).toBe(
			"connection-json-v2:d6f069a8f2b97ab44cc307a465f10e687b92cad2758c69793bc446d4bc5c5a30",
		);
		expect(canonicalHashMatches(legacyInput, legacyHash)).toBe(true);
		expect(canonicalHashMatches({ label: composed }, legacyHash)).toBe(false);
		expect(() => canonicalJson({ [composed]: 1, [decomposed]: 2 })).toThrow(
			ConnectionError,
		);
		expect(() => canonicalJson({ value: String.fromCharCode(0xd800) })).toThrow(
			ConnectionError,
		);
	});

	it("lists provider apps from the current identity's authorized Actions", async () => {
		const service = new ConnectionApplicationService(new MemoryRepository(), {
			execute: async () => ({}),
		});

		expect(await service.listDirectAppsForIdentity(direct, "GIT")).toEqual([
			{ actionCount: 2, service: "github" },
		]);
		expect(await service.listDirectAppsForIdentity(direct, "slack")).toEqual(
			[],
		);
	});

	it("filters the current identity's authorized Connections by provider service", async () => {
		const service = new ConnectionApplicationService(new MemoryRepository(), {
			execute: async () => ({}),
		});

		expect(
			await service.listDirectConnectionsForIdentity(direct, "github"),
		).toHaveLength(1);
		expect(
			await service.listDirectConnectionsForIdentity(direct, "slack"),
		).toEqual([]);
	});

	it("searches the current identity's authorized Actions and returns public ids", async () => {
		const service = new ConnectionApplicationService(new MemoryRepository(), {
			execute: async () => ({}),
		});

		expect(
			await service.searchDirectActionsForIdentity(direct, {
				limit: 1,
				query: "PULL",
				service: "GITHUB",
			}),
		).toEqual([
			{
				actionId: "github.createPullRequest",
				actionVersionId: "github.createPullRequest@v1",
				description: "Create pull request",
				effect: "WRITE",
				name: "github.createPullRequest",
			},
		]);
		expect(
			await service.searchDirectActionsForIdentity(direct, {
				service: "slack",
			}),
		).toEqual([]);
	});

	it("builds a deterministic guide for an authorized public Action id", async () => {
		const service = new ConnectionApplicationService(new MemoryRepository(), {
			execute: async () => ({}),
		});

		const guide = await service.getDirectActionGuideForIdentity(
			direct,
			"github.createPullRequest",
		);
		expect(guide.action).toMatchObject({
			actionId: "github.createPullRequest",
			actionVersionId: "github.createPullRequest@v1",
			effect: "WRITE",
		});
		expect(guide.inputSchema.required).toContain("idempotencyKey");
		expect(guide.guide).toContain('"idempotencyKey"');
		await expect(
			service.getDirectActionGuideForIdentity(direct, "github.unknown"),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
	});

	it("executes an authorized public Action id without a route map", async () => {
		const service = new ConnectionApplicationService(new MemoryRepository(), {
			execute: async () => ({ fullName: "acme/widgets" }),
		});

		expect(
			await service.executeDirectActionForIdentity(
				direct,
				"github.getRepository",
				{ repository: "acme/widgets" },
			),
		).toMatchObject({
			action: "github.getRepository",
			result: { fullName: "acme/widgets" },
			status: "SUCCEEDED",
		});
		await expect(
			service.executeDirectActionForIdentity(direct, "github.unknown", {}),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
	});

	it("shares direct idempotency across a Principal's devices and never exposes credentials", async () => {
		const repository = new MemoryRepository();
		const executor: GitHubExecutor = {
			execute: async () => ({
				pullRequestUrl: "https://github.test/acme/widgets/pull/1",
			}),
		};
		const service = new ConnectionApplicationService(repository, executor);
		const directFirst = await service.invokeDirect(
			"direct",
			"github.createPullRequest",
			{
				base: "main",
				head: "feature/login",
				idempotencyKey: "retry-1",
				repository: "acme/widgets",
				title: "Login",
			},
		);
		repository.directInvocation = {
			...direct,
			instanceId: "codex-second-device",
		};
		const directRetry = await service.invokeDirect(
			"direct",
			"github.createPullRequest",
			{
				base: "main",
				head: "feature/login",
				idempotencyKey: "retry-1",
				repository: "acme/widgets",
				title: "Login",
			},
		);
		const delegatedCall = await service.invokeDelegated(
			"workload",
			"github.createPullRequest",
			{
				base: "main",
				head: "feature/login",
				repository: "acme/widgets",
				title: "Login",
			},
			"retry-1",
		);
		expect(directRetry.callId).toBe(directFirst.callId);
		expect(delegatedCall.callId).not.toBe(directFirst.callId);
		expect(JSON.stringify(directFirst)).not.toContain("test-secret");
	});

	it("reuses a legacy v1 idempotency record for the exact original request", async () => {
		const repository = new MemoryRepository();
		const service = new ConnectionApplicationService(repository, {
			execute: async () => ({
				pullRequestUrl: "https://github.test/pr/legacy",
			}),
		});
		const input = {
			base: "main",
			head: "feature/legacy-hash",
			idempotencyKey: "legacy-hash-retry",
			repository: "acme/widgets",
			title: "Legacy hash",
		};
		const first = await service.invokeDirect(
			"direct",
			"github.createPullRequest",
			input,
		);
		const stored = repository.calls[0];
		if (!stored) throw new Error("Expected the first call to be stored");
		stored.argsHash = canonicalHashForVersion(canonicalJsonVersions.legacy, {
			action: "github.createPullRequest",
			input,
		});

		const retry = await service.invokeDirect(
			"direct",
			"github.createPullRequest",
			input,
		);

		expect(retry.callId).toBe(first.callId);
		expect(repository.calls).toHaveLength(1);
	});

	it("rejects selector input and a repeated key with changed input", async () => {
		const service = new ConnectionApplicationService(new MemoryRepository(), {
			execute: async () => ({}),
		});
		await expect(
			service.invokeDirect("direct", "github.getRepository", {
				connectionId: "other",
				repository: "acme/widgets",
			}),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		await service.invokeDirect("direct", "github.createPullRequest", {
			base: "main",
			head: "feature/a",
			idempotencyKey: "retry-1",
			repository: "acme/widgets",
			title: "A",
		});
		await expect(
			service.invokeDirect("direct", "github.createPullRequest", {
				base: "main",
				head: "feature/b",
				idempotencyKey: "retry-1",
				repository: "acme/widgets",
				title: "B",
			}),
		).rejects.toBeInstanceOf(ConnectionError);
	});

	it("validates the full action schema before admitting a write", async () => {
		const repository = new MemoryRepository();
		let executed = false;
		const service = new ConnectionApplicationService(repository, {
			execute: async () => {
				executed = true;
				return {};
			},
		});
		await expect(
			service.invokeDirect("direct", "github.createPullRequest", {
				base: "main",
				head: "feature/schema-validation",
				idempotencyKey: "schema-validation",
				repository: "acme/widgets",
				title: 42,
			}),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		expect(repository.calls).toHaveLength(0);
		expect(executed).toBe(false);
	});

	it("reuses a write after a replacement Grant for the same Direct subject", async () => {
		const repository = new MemoryRepository();
		const service = new ConnectionApplicationService(repository, {
			execute: async () => ({ pullRequestUrl: "https://github.test/pr/1" }),
		});
		const input = {
			base: "main",
			head: "feature/retry",
			idempotencyKey: "retry-after-grant-replacement",
			repository: "acme/widgets",
			title: "Retry",
		};
		const first = await service.invokeDirect(
			"direct",
			"github.createPullRequest",
			input,
		);
		repository.directInvocation = {
			...direct,
			credentialVersionId: "credential-2",
			grantId: "grant-alice-replacement",
		};
		const retry = await service.invokeDirect(
			"direct",
			"github.createPullRequest",
			input,
		);

		expect(retry.callId).toBe(first.callId);
		expect(repository.calls).toHaveLength(1);
	});

	it("records a denied local call when dispatch admission observes revocation", async () => {
		const repository = new MemoryRepository();
		repository.rejectNextDispatch = true;
		let executions = 0;
		const service = new ConnectionApplicationService(repository, {
			execute: async () => {
				executions += 1;
				return {};
			},
		});

		await expect(
			service.invokeDirect("direct", "github.createPullRequest", {
				base: "main",
				head: "feature/revoked",
				idempotencyKey: "revoked-before-dispatch",
				repository: "acme/widgets",
				title: "Revoked",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(executions).toBe(0);
		expect(repository.calls).toHaveLength(1);
		expect(repository.calls[0]?.status).toBe("DENIED_LOCAL");
	});

	it("records read Provider failures without entering reconciliation", async () => {
		const repository = new MemoryRepository();
		repository.rejectNextDispatch = true;
		const service = new ConnectionApplicationService(repository, {
			execute: async () => {
				throw new Error("repository not found");
			},
		});

		await expect(
			service.invokeDirect("direct", "github.getRepository", {
				repository: "acme/missing",
			}),
		).rejects.toMatchObject({ code: "PROVIDER_FAILED" });

		expect(repository.calls[0]?.status).toBe("FAILED");
		expect(repository.reconciliationJobs).toHaveLength(0);
	});

	it("creates a PKCE OAuth transaction and consumes its state only once", async () => {
		const repository = new MemoryRepository();
		const oauth: GitHubOAuthProvider = {
			exchangeCode: async ({ codeVerifier, code, redirectUri }) => {
				expect(code).toBe("authorization-code");
				expect(codeVerifier).toHaveLength(43);
				expect(redirectUri).toBe(
					"https://connection.test/oauth/github/callback",
				);
				return {
					accessToken: "provider-secret",
					displayName: "Alice GitHub",
					externalAccount: "alice-github",
					grantedScopes: ["repo"],
				};
			},
			getAuthorizationUrl: ({ codeChallenge, redirectUri, state }) =>
				`https://github.test/authorize?challenge=${codeChallenge}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
		};
		const service = new ConnectionApplicationService(
			repository,
			{ execute: async () => ({}) },
			oauth,
		);
		const start = await service.startGithubOAuth(
			"alice",
			"https://connection.test/oauth/github/callback",
		);
		const authorizationUrl = new URL(start.authorizationUrl);
		const state = authorizationUrl.searchParams.get("state");
		expect(state).toHaveLength(43);
		expect(authorizationUrl.searchParams.get("challenge")).toHaveLength(43);
		await service.completeGithubOAuth("authorization-code", state ?? "");
		expect(repository.storedOAuthCredential).toEqual({
			accessToken: "provider-secret",
			displayName: "Alice GitHub",
			externalAccount: "alice-github",
			grantedScopes: ["repo"],
			principalId: "alice",
		});
		await expect(
			service.completeGithubOAuth("authorization-code", state ?? ""),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });

		const shared = await service.startSharedGithubOAuth(
			"admin",
			"shared-scope-company",
			"https://connection.test/oauth/github/callback",
		);
		const sharedState = new URL(shared.authorizationUrl).searchParams.get(
			"state",
		);
		await service.completeGithubOAuth("authorization-code", sharedState ?? "");
		expect(repository.storedSharedOAuthCredential).toEqual({
			accessToken: "provider-secret",
			actorPrincipalId: "admin",
			displayName: "Alice GitHub",
			externalAccount: "alice-github",
			grantedScopes: ["repo"],
			sharedScopeId: "shared-scope-company",
		});
	});

	it("reconciles an admitted write with missing terminal evidence", async () => {
		const repository = new MemoryRepository();
		const service = new ConnectionApplicationService(repository, {
			execute: async () => {
				throw new Error("response lost");
			},
		});
		await expect(
			service.invokeDirect("direct", "github.createPullRequest", {
				base: "main",
				head: "feature/recover",
				idempotencyKey: "recover-1",
				repository: "acme/widgets",
				title: "Recover",
			}),
		).rejects.toMatchObject({ code: "PROVIDER_UNCERTAIN" });
		expect(repository.calls[0]?.status).toBe("UNCERTAIN");
		const reconciler: GitHubReconciler = {
			reconcile: async () => ({
				pullRequestUrl: "https://github.test/acme/widgets/pull/42",
			}),
		};
		const recovery = new ConnectionRecoveryService(repository, reconciler);
		expect(await recovery.runOnce()).toBe(true);
		expect(repository.calls[0]?.status).toBe("SUCCEEDED");
		expect(await recovery.runOnce()).toBe(false);
	});

	it("marks a Provider response uncertain when terminal persistence fails", async () => {
		const repository = new MemoryRepository();
		repository.failSuccessfulFinalization = true;
		const service = new ConnectionApplicationService(repository, {
			execute: async () => ({
				pullRequestUrl: "https://github.test/acme/widgets/pull/42",
			}),
		});
		await expect(
			service.invokeDirect("direct", "github.createPullRequest", {
				base: "main",
				head: "feature/finalize",
				idempotencyKey: "finalize-1",
				repository: "acme/widgets",
				title: "Finalize",
			}),
		).rejects.toMatchObject({ code: "PROVIDER_UNCERTAIN" });
		expect(repository.calls[0]?.status).toBe("UNCERTAIN");
	});

	it("does not hot-loop an uncertain write while provider evidence is unavailable", async () => {
		const repository = new MemoryRepository();
		const service = new ConnectionApplicationService(repository, {
			execute: async () => {
				const error = new Error("response lost") as Error & {
					submissionUncertain: boolean;
				};
				error.submissionUncertain = true;
				throw error;
			},
		});
		await expect(
			service.invokeDirect("direct", "github.createPullRequest", {
				base: "main",
				head: "feature/pending",
				idempotencyKey: "pending-1",
				repository: "acme/widgets",
				title: "Pending",
			}),
		).rejects.toMatchObject({ code: "PROVIDER_UNCERTAIN" });
		const recovery = new ConnectionRecoveryService(repository, {
			reconcile: async () => undefined,
		});
		expect(await recovery.runOnce()).toBe(true);
		expect(repository.calls[0]?.status).toBe("UNCERTAIN");
		expect(repository.rescheduledCallIds).toEqual(["call-1"]);
		expect(await recovery.runOnce()).toBe(false);
	});

	it("fences an expired recovery worker from completing a newly leased job", async () => {
		const repository = new MemoryRepository();
		const service = new ConnectionApplicationService(repository, {
			execute: async () => {
				const error = new Error("response lost") as Error & {
					submissionUncertain: boolean;
				};
				error.submissionUncertain = true;
				throw error;
			},
		});
		await expect(
			service.invokeDirect("direct", "github.createPullRequest", {
				base: "main",
				head: "feature/lease",
				idempotencyKey: "lease-1",
				repository: "acme/widgets",
				title: "Lease",
			}),
		).rejects.toMatchObject({ code: "PROVIDER_UNCERTAIN" });
		const firstLease = await repository.claimReconciliationJob();
		if (!firstLease) throw new Error("Expected the first recovery lease");
		await repository.rescheduleReconciliationJob({
			callId: firstLease.callId,
			leaseId: firstLease.leaseId,
			reason: "Lease expired",
		});
		repository.reconciliationJobs.push({
			...firstLease,
			leaseId: "pending",
		});
		const secondLease = await repository.claimReconciliationJob();
		expect(secondLease?.leaseId).not.toBe(firstLease?.leaseId);

		await repository.completeReconciliationJob({
			callId: firstLease.callId,
			leaseId: firstLease.leaseId,
			result: { pullRequestUrl: "https://github.test/stale" },
		});
		expect(repository.calls[0]?.status).toBe("UNCERTAIN");

		await repository.completeReconciliationJob({
			callId: secondLease?.callId ?? "",
			leaseId: secondLease?.leaseId ?? "",
			result: { pullRequestUrl: "https://github.test/current" },
		});
		expect(repository.calls[0]?.status).toBe("SUCCEEDED");
	});

	it("aggregates Direct actions across Provider Grants and routes execution by Action", async () => {
		const repository = new MemoryRepository();
		const bitbucketInvocation = {
			...direct,
			connectionId: "connection-bitbucket",
			credentialVersionId: "credential-bitbucket",
			grantId: "grant-bitbucket",
		};
		const bitbucketAction: ActionDefinition = {
			description: "List Bitbucket projects",
			effect: "READ",
			id: "bitbucket.list_projects@v1",
			inputSchema: {
				additionalProperties: false,
				properties: {},
				required: [],
				type: "object",
			},
			name: "bitbucket.list_projects",
			requiredScopes: ["bitbucket.server.pat"],
		};
		repository.resolveDirectIdentities = async () => [
			direct,
			bitbucketInvocation,
		];
		repository.listAuthorizedActions = async (
			invocation?: InvocationContext,
		) =>
			invocation?.grantId === bitbucketInvocation.grantId
				? [bitbucketAction]
				: actions;
		const executed: string[] = [];
		const service = new ConnectionApplicationService(repository, {
			execute: async ({ action }) => {
				executed.push(action);
				return { ok: true };
			},
		});

		expect(await service.listDirectAppsForIdentity(direct)).toEqual([
			{ actionCount: 1, service: "bitbucket" },
			{ actionCount: 2, service: "github" },
		]);
		await service.executeDirectActionForIdentity(
			direct,
			"bitbucket.list_projects",
			{},
		);
		expect(executed).toEqual(["bitbucket.list_projects"]);
	});

	it("treats rejected Provider credentials as a definite validation failure", async () => {
		const repository = new MemoryRepository();
		const service = new ConnectionApplicationService(
			repository,
			{ execute: async () => ({}) },
			undefined,
			{
				bitbucket: {
					providerId: "bitbucket",
					providerReleaseId: "bitbucket-server-v1",
					validateCredential: async () => {
						throw Object.assign(new Error("denied"), {
							providerCredentialInvalid: true,
						});
					},
				},
			},
		);
		await expect(
			service.connectProviderCredential("alice", "bitbucket", "test-pat"),
		).rejects.toMatchObject({
			code: "INVALID_REQUEST",
			message: "Provider credential validation failed",
		});
		expect(repository.storedOAuthCredential).toBeUndefined();
	});

	it("classifies Provider credential transport failures as unavailable", async () => {
		const service = new ConnectionApplicationService(
			new MemoryRepository(),
			{ execute: async () => ({}) },
			undefined,
			{
				bitbucket: {
					providerId: "bitbucket",
					providerReleaseId: "bitbucket-server-v1",
					validateCredential: async () => {
						throw new Error("timeout");
					},
				},
			},
		);
		await expect(
			service.connectProviderCredential("alice", "bitbucket", "test-pat"),
		).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
	});

	it("does not retry an uncertain Bitbucket write with the same idempotency key", async () => {
		const repository = new MemoryRepository();
		const bitbucketInvocation = {
			...direct,
			connectionId: "connection-bitbucket-write",
			credentialVersionId: "credential-bitbucket-write",
			grantId: "grant-bitbucket-write",
		};
		const action: ActionDefinition = {
			description: "Create Bitbucket pull request",
			effect: "WRITE",
			id: "bitbucket.create_pull_request@v1",
			inputSchema: {
				additionalProperties: false,
				properties: {
					destinationBranch: { type: "string" },
					project: { type: "string" },
					repository: { type: "string" },
					sourceBranch: { type: "string" },
					title: { type: "string" },
				},
				required: [
					"project",
					"repository",
					"title",
					"sourceBranch",
					"destinationBranch",
				],
				type: "object",
			},
			name: "bitbucket.create_pull_request",
			requiredScopes: ["bitbucket.server.pat"],
		};
		repository.resolveDirectIdentities = async () => [bitbucketInvocation];
		repository.listAuthorizedActions = async () => [action];
		let submissions = 0;
		const service = new ConnectionApplicationService(repository, {
			execute: async () => {
				submissions += 1;
				throw new Error("response lost");
			},
		});
		const input = {
			destinationBranch: "main",
			idempotencyKey: "bitbucket-pr-1",
			project: "PROJ",
			repository: "repo",
			sourceBranch: "feature",
			title: "Feature",
		};

		await expect(
			service.executeDirectActionForIdentity(
				direct,
				"bitbucket.create_pull_request",
				input,
			),
		).rejects.toMatchObject({ code: "PROVIDER_UNCERTAIN" });
		expect(submissions).toBe(1);
		expect(
			await service.executeDirectActionForIdentity(
				direct,
				"bitbucket.create_pull_request",
				input,
			),
		).toMatchObject({ status: "UNCERTAIN" });
		expect(submissions).toBe(1);
	});

	it("routes execution by the authorized ProviderRelease instead of the Action string", async () => {
		const executions: string[] = [];
		const router = new ProviderExecutorRouter({
			"bitbucket-release-v1": {
				execute: async ({ providerId }) => {
					executions.push(providerId);
					return {};
				},
			},
		});
		await expect(async () =>
			router.execute({
				action: "github.get_repository",
				actionVersionId: "github.get_repository@v1",
				credential: { accessToken: "test-secret" },
				input: {},
				providerId: "bitbucket",
				providerReleaseId: "bitbucket-release-v1",
			}),
		).rejects.toMatchObject({ code: "PROVIDER_FAILED" });
		expect(executions).toEqual([]);
	});

	it("binds delegated Provider resolution to the asserted Actor", async () => {
		const repository = new MemoryRepository();
		let resolvedActor: string | undefined;
		repository.resolveDelegatedWorkloads = async (_workload, actorKey) => {
			resolvedActor = actorKey;
			return [delegated];
		};
		const service = new ConnectionApplicationService(repository, {
			execute: async () => ({ ok: true }),
		});
		await service.invokeDelegated(
			{
				actionVersionId: "github.getRepository@v1",
				actorId: delegated.actorKey,
				workload: "workload",
			},
			"github.getRepository",
			{ repository: "acme/widgets" },
		);
		expect(resolvedActor).toBe(delegated.actorKey);
	});
});
