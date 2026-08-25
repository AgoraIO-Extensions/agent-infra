import { createHash } from "node:crypto";
import type { Schema } from "@cfworker/json-schema";
import { Validator } from "@cfworker/json-schema";

export * from "./oauth";

export const forbiddenSelectorNames = new Set([
	"accountId",
	"accessToken",
	"actorId",
	"authorization",
	"connectionId",
	"consumerId",
	"consumerInstanceId",
	"credential",
	"credentialId",
	"credentialVersionId",
	"endpoint",
	"externalAccountId",
	"principalId",
	"token",
	"userId",
]);

/** Provider Action identifiers come from the published Connection catalog. */
export type ActionName = string;

/** @deprecated Use ActionName; kept for the GitHub OAuth/adapter contract. */
export type GitHubActionName = ActionName;

export type CallStatus =
	| "AUTHORIZED"
	| "DENIED_LOCAL"
	| "SUCCEEDED"
	| "FAILED"
	| "UNCERTAIN";

export type ActionDefinition = {
	description: string;
	effect: "READ" | "WRITE";
	id: string;
	inputSchema: { required: readonly string[]; [key: string]: unknown };
	name: ActionName;
	requiredScopes: readonly string[];
};

const actionValidators = new WeakMap<ActionDefinition, Validator>();

export function actionInputSchema(action: ActionDefinition) {
	const required = [...action.inputSchema.required];
	const properties = {
		...((action.inputSchema.properties as
			| Record<string, unknown>
			| undefined) ?? {}),
	};
	if (action.effect === "WRITE") {
		if (!required.includes("idempotencyKey")) required.push("idempotencyKey");
		if (!("idempotencyKey" in properties)) {
			properties.idempotencyKey = { minLength: 1, type: "string" };
		}
	}
	return { ...action.inputSchema, properties, required };
}

export type InvocationContext = {
	actorKey?: string;
	connectionId: string;
	consumerId: string;
	credentialVersionId: string;
	grantId: string;
	instanceId: string;
	principalId: string;
};

export type DelegatedAssertionBinding = {
	argsHash?: string;
	actionVersionId?: string;
	consumerId?: string;
	consumerInstanceId?: string;
	deadlineAt?: string;
	idempotencyKeyHash?: string;
	jti?: string;
	organizationContext?: string;
	principalIssuer?: string;
	principalSubject?: string;
	recoveryGeneration?: string;
	workloadBindingHash?: string;
	actorId?: string;
};

export type ConnectionOverview = {
	actions: ActionDefinition[];
	calls: CallProjection[];
	connections: Array<{
		actionVersionIds: string[];
		displayName: string;
		externalAccount: string;
		id: string;
		ownerType: "PERSONAL" | "SHARED";
		requiresReconnect: boolean;
		status: "ACTIVE" | "DISCONNECTED";
	}>;
	consumers: Array<{ id: string; name: string }>;
	grants: Array<{
		actionVersionIds: string[];
		connectionId: string;
		consumerId: string;
		consumerName: string;
		id: string;
		status:
			| "ACTIVE"
			| "PAUSED_CONNECTION"
			| "PAUSED_CREDENTIAL"
			| "REPLACED"
			| "REVOKED"
			| "TERMINATED";
	}>;
	principal: { displayName: string; id: string };
};

export type ConnectionPrincipalSummary = {
	displayName: string;
	email: string | null;
	principalId: string;
};

export type ConnectionAdministrator = ConnectionPrincipalSummary;

export type ConnectionAdministratorCandidate = ConnectionPrincipalSummary & {
	isAdministrator: boolean;
};

export type SharedGithubAdministration = {
	principals: ConnectionPrincipalSummary[];
	scopes: Array<{
		connections: Array<{
			displayName: string;
			externalAccount: string;
			id: string;
			status: "ACTIVE" | "DISCONNECTED";
		}>;
		displayName: string;
		members: string[];
		sharedScopeId: string;
		state: "ACTIVE" | "SUSPENDED" | "DISABLED";
	}>;
};

export type CurrentConsumerAuthorizationPreview = {
	actions: Array<
		Pick<
			ActionDefinition,
			"description" | "effect" | "id" | "name" | "requiredScopes"
		>
	>;
	confirmationToken: string;
	consumer: { id: string; name: string };
	currentConnection?: {
		displayName: string;
		externalAccount: string;
		id: string;
	};
	effectSummary: Array<ActionDefinition["effect"]>;
	expiresAt: string;
	previewId: string;
	requiredScopes: string[];
	targetConnection: {
		displayName: string;
		externalAccount: string;
		id: string;
	};
};

export type CallProjection = {
	action: GitHubActionName;
	callId: string;
	connectionId: string;
	createdAt: string;
	grantId: string;
	result?: Record<string, unknown>;
	status: CallStatus;
};

export type StoredCall = CallProjection & {
	argsHash: string;
	idempotencyKey?: string;
	invocation: InvocationContext;
};

export const canonicalJsonVersions = {
	legacy: "connection-json-v1",
	current: "connection-json-v2",
} as const;

type CanonicalJsonVersion =
	(typeof canonicalJsonVersions)[keyof typeof canonicalJsonVersions];

function rejectUnpairedSurrogates(value: string) {
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit < 0xd800 || codeUnit > 0xdfff) continue;
		const isHighSurrogate = codeUnit <= 0xdbff;
		const next = value.charCodeAt(index + 1);
		if (
			(isHighSurrogate &&
				(!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff)) ||
			(!isHighSurrogate &&
				(!Number.isInteger(value.charCodeAt(index - 1)) ||
					value.charCodeAt(index - 1) < 0xd800 ||
					value.charCodeAt(index - 1) > 0xdbff))
		) {
			throw new ConnectionError(
				"INVALID_REQUEST",
				"Hash input must not contain unpaired Unicode surrogates",
			);
		}
		if (isHighSurrogate) index += 1;
	}
}

function compareUnicodeScalars(left: string, right: string) {
	const leftScalars = [...left];
	const rightScalars = [...right];
	for (
		let index = 0;
		index < Math.min(leftScalars.length, rightScalars.length);
		index += 1
	) {
		const leftScalar = leftScalars[index]?.codePointAt(0) ?? 0;
		const rightScalar = rightScalars[index]?.codePointAt(0) ?? 0;
		if (leftScalar !== rightScalar) return leftScalar - rightScalar;
	}
	return leftScalars.length - rightScalars.length;
}

function canonicalJsonV1(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new ConnectionError(
				"INVALID_REQUEST",
				"Hash input must contain finite JSON numbers",
			);
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalJsonV1(entry)).join(",")}]`;
	}
	if (typeof value === "object") {
		if (Object.getPrototypeOf(value) !== Object.prototype) {
			throw new ConnectionError(
				"INVALID_REQUEST",
				"Hash input must contain plain JSON objects only",
			);
		}
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJsonV1(record[key])}`)
			.join(",")}}`;
	}
	throw new ConnectionError(
		"INVALID_REQUEST",
		"Hash input must contain JSON values only",
	);
}

/**
 * Canonical JSON for security-relevant Connection hashes. Version two normalizes
 * strings and object keys to NFC, sorts keys by Unicode scalar value, preserves array
 * order, and rejects inputs outside the JSON data model.
 */
export function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") {
		rejectUnpairedSurrogates(value);
		return JSON.stringify(value.normalize("NFC"));
	}
	if (typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new ConnectionError(
				"INVALID_REQUEST",
				"Hash input must contain finite JSON numbers",
			);
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	}
	if (typeof value === "object") {
		if (Object.getPrototypeOf(value) !== Object.prototype) {
			throw new ConnectionError(
				"INVALID_REQUEST",
				"Hash input must contain plain JSON objects only",
			);
		}
		const record = value as Record<string, unknown>;
		const normalizedEntries = Object.keys(record).map((key) => {
			rejectUnpairedSurrogates(key);
			return { key: key.normalize("NFC"), value: record[key] };
		});
		normalizedEntries.sort((left, right) =>
			compareUnicodeScalars(left.key, right.key),
		);
		for (let index = 1; index < normalizedEntries.length; index += 1) {
			if (normalizedEntries[index - 1]?.key === normalizedEntries[index]?.key) {
				throw new ConnectionError(
					"INVALID_REQUEST",
					"Hash input contains duplicate keys after Unicode normalization",
				);
			}
		}
		return `{${normalizedEntries
			.map(
				(entry) => `${JSON.stringify(entry.key)}:${canonicalJson(entry.value)}`,
			)
			.join(",")}}`;
	}
	throw new ConnectionError(
		"INVALID_REQUEST",
		"Hash input must contain JSON values only",
	);
}

export function canonicalHashForVersion(
	version: CanonicalJsonVersion,
	value: unknown,
): string {
	const canonical =
		version === canonicalJsonVersions.legacy
			? canonicalJsonV1(value)
			: canonicalJson(value);
	const digest = createHash("sha256")
		.update(`${version}:${canonical}`)
		.digest("hex");
	return `${version}:${digest}`;
}

export function canonicalHash(value: unknown): string {
	return canonicalHashForVersion(canonicalJsonVersions.current, value);
}

export function canonicalHashMatches(value: unknown, storedHash: string) {
	if (storedHash.startsWith(`${canonicalJsonVersions.current}:`)) {
		return storedHash === canonicalHash(value);
	}
	if (storedHash.startsWith(`${canonicalJsonVersions.legacy}:`)) {
		return (
			storedHash ===
			canonicalHashForVersion(canonicalJsonVersions.legacy, value)
		);
	}
	return false;
}

function projectCall(call: StoredCall): CallProjection {
	return {
		action: call.action,
		callId: call.callId,
		connectionId: call.connectionId,
		createdAt: call.createdAt,
		grantId: call.grantId,
		result: call.result,
		status: call.status,
	};
}

export type CredentialForExecution = { accessToken: string };

export type GitHubOAuthAuthorization = {
	codeChallenge: string;
	state: string;
};

export type GitHubOAuthIdentity = {
	accessToken: string;
	displayName: string;
	externalAccount: string;
	grantedScopes: string[];
};

export type AuthorizationSourceRevisions = {
	actionSetDigest: string;
	catalogRevisionDigest: string;
	connectionExecutionFence: string;
	connectionRevision: string;
	consumerDeclarationDigest: string;
	consumerDeclarationId: string;
	consumerDeclarationRevision: string;
	consumerRevision: string;
	credentialRevision: string;
	credentialScopeDigest: string;
	credentialVersionId: string;
	currentGrantId: string | null;
	externalAccountFingerprint: string;
	providerReleaseId: string;
	providerReleaseRevision: string;
	rootFence: string;
	rootStatus: string;
	sharedEligibilityPathHash: string | null;
};

export type AuthorizationSnapshot = {
	actionSetDigest: string;
	authorizationDigest: string;
	sourceRevisions: AuthorizationSourceRevisions;
};

export function createAuthorizationSnapshot(input: {
	actions: readonly ActionDefinition[];
	connection: { displayName: string; externalAccount: string; id: string };
	consumer: { id: string; name: string };
	principalId: string;
	sourceRevisions: Omit<AuthorizationSourceRevisions, "actionSetDigest">;
}): AuthorizationSnapshot {
	const actionSetDigest = canonicalHash(input.actions);
	const sourceRevisions = { ...input.sourceRevisions, actionSetDigest };
	return {
		actionSetDigest,
		authorizationDigest: canonicalHash({
			actions: input.actions,
			connection: input.connection,
			consumer: input.consumer,
			principalId: input.principalId,
			sourceRevisions,
		}),
		sourceRevisions,
	};
}

export function authorizationSnapshotMatches(
	stored: {
		actionSetDigest: string;
		actionVersionIds: unknown;
		authorizationDigest: string;
		sourceRevisions: unknown;
	},
	current: AuthorizationSnapshot & { actionVersionIds: readonly string[] },
) {
	return (
		Array.isArray(stored.actionVersionIds) &&
		canonicalHash(stored.actionVersionIds) ===
			canonicalHash(current.actionVersionIds) &&
		stored.actionSetDigest === current.actionSetDigest &&
		stored.authorizationDigest === current.authorizationDigest &&
		canonicalHash(stored.sourceRevisions) ===
			canonicalHash(current.sourceRevisions)
	);
}

export function decideReconnectAuthorization(input: {
	current: {
		actionVersionIds: unknown;
		actorKey: string;
		confirmedActionSetDigest: string | null;
		consentId: string | null;
		consumerDeclarationId: string | null;
		credentialScopeDigest: string | null;
		externalAccountFingerprint: string | null;
		providerId: string;
		providerReleaseId: string | null;
		rootStatus: string;
		sharedEligibilityPathHash: string | null;
	};
	target:
		| {
				actions: readonly ActionDefinition[];
				consumerDeclarationId: string;
				credentialScopeDigest: string;
				externalAccountFingerprint: string;
				providerId: string;
				providerReleaseId: string;
				sharedEligibilityPathHash: string | null;
		  }
		| undefined;
}): "REPLACE_GRANT" | "REQUIRE_RECONFIRMATION" {
	const { current, target } = input;
	if (
		current.actorKey === "" &&
		current.consentId !== null &&
		current.rootStatus === "ACTIVE" &&
		target !== undefined &&
		current.providerId === target.providerId &&
		current.providerReleaseId === target.providerReleaseId &&
		current.consumerDeclarationId === target.consumerDeclarationId &&
		current.externalAccountFingerprint === target.externalAccountFingerprint &&
		current.sharedEligibilityPathHash === target.sharedEligibilityPathHash &&
		current.credentialScopeDigest === target.credentialScopeDigest &&
		current.confirmedActionSetDigest === canonicalHash(target.actions) &&
		canonicalHash(current.actionVersionIds) ===
			canonicalHash(target.actions.map((action) => action.id))
	) {
		return "REPLACE_GRANT";
	}
	return "REQUIRE_RECONFIRMATION";
}

export type OAuthTransaction = {
	codeVerifier: string;
	principalId: string;
	redirectUri: string;
	sharedScopeId?: string;
};

export type ReconciliationJob = {
	action: GitHubActionName;
	callId: string;
	input: Record<string, unknown>;
	invocation: InvocationContext;
	leaseId: string;
};

export interface ConnectionRepository {
	ensurePrincipal(input: { principalId: string }): Promise<void>;
	authorizeConnectionAdministration(principalId: string): Promise<boolean>;
	isConnectionAdministrator(principalId: string): Promise<boolean>;
	grantConnectionAdministrator(input: {
		actorPrincipalId: string;
		targetPrincipalId: string;
	}): Promise<void>;
	listConnectionAdministratorCandidates(
		principalId: string,
	): Promise<ConnectionAdministratorCandidate[]>;
	listConnectionAdministrators(
		principalId: string,
	): Promise<ConnectionAdministrator[]>;
	revokeConnectionAdministrator(input: {
		actorPrincipalId: string;
		targetPrincipalId: string;
	}): Promise<void>;
	createSharedScope(input: {
		actorPrincipalId: string;
		displayName: string;
	}): Promise<{ sharedScopeId: string }>;
	grantSharedScopePrincipal(input: {
		actorPrincipalId: string;
		sharedScopeId: string;
		targetPrincipalId: string;
	}): Promise<void>;
	revokeSharedScopePrincipal(input: {
		actorPrincipalId: string;
		sharedScopeId: string;
		targetPrincipalId: string;
	}): Promise<void>;
	renameSharedScope(input: {
		actorPrincipalId: string;
		displayName: string;
		sharedScopeId: string;
	}): Promise<void>;
	confirmCurrentConsumerAuthorization(input: {
		confirmationToken: string;
		idempotencyKey: string;
		previewId: string;
		principalId: string;
	}): Promise<{ grantId: string }>;
	createCurrentConsumerAuthorizationPreview(input: {
		connectionId: string;
		consumerId: string;
		principalId: string;
	}): Promise<CurrentConsumerAuthorizationPreview>;
	publishConsumerDeclaration(input: {
		actionVersionIds: readonly string[];
		consumer: { id: string; name: string };
		providerReleaseId: string;
	}): Promise<{ declarationId: string }>;
	createCall(input: {
		action: GitHubActionName;
		actionVersionId?: string;
		argsHash: string;
		delegatedAssertion?: DelegatedAssertionBinding;
		idempotencyKey?: string;
		input: Record<string, unknown>;
		invocation: InvocationContext;
	}): Promise<{ call: StoredCall; created: boolean }>;
	claimReconciliationJob(): Promise<ReconciliationJob | undefined>;
	completeReconciliationJob(input: {
		callId: string;
		leaseId: string;
		result: Record<string, unknown>;
	}): Promise<void>;
	disconnectConnection(input: {
		connectionId: string;
		principalId: string;
	}): Promise<void>;
	disconnectSharedConnection(input: {
		actorPrincipalId: string;
		connectionId: string;
	}): Promise<void>;
	consumeOAuthTransaction(state: string): Promise<OAuthTransaction>;
	createOAuthTransaction(
		input: OAuthTransaction & { state: string },
	): Promise<void>;
	storeGithubOAuthCredential(input: {
		accessToken: string;
		displayName: string;
		externalAccount: string;
		grantedScopes: readonly string[];
		principalId: string;
	}): Promise<{ connectionId: string }>;
	storeSharedGithubOAuthCredential(input: {
		accessToken: string;
		actorPrincipalId: string;
		displayName: string;
		externalAccount: string;
		grantedScopes: readonly string[];
		sharedScopeId: string;
	}): Promise<{ connectionId: string }>;
	findIdempotentCall(input: {
		action: GitHubActionName;
		idempotencyKey: string;
		invocation: InvocationContext;
	}): Promise<StoredCall | undefined>;
	getCredential(invocation: InvocationContext): Promise<CredentialForExecution>;
	getOverview(principalId: string): Promise<ConnectionOverview>;
	listAuthorizedConnections(
		invocation: InvocationContext,
	): Promise<ConnectionOverview["connections"]>;
	listAuthorizedActions(
		invocation: InvocationContext,
	): Promise<ActionDefinition[]>;
	sharedGithubAdministration(
		actorPrincipalId: string,
	): Promise<SharedGithubAdministration>;
	resolveDelegatedWorkload(
		workload: string | undefined,
	): Promise<InvocationContext>;
	resolveDirectSession(session: string | undefined): Promise<InvocationContext>;
	resolveDirectIdentity(input: {
		consumerId: string;
		instanceId: string;
		principalId: string;
	}): Promise<InvocationContext>;
	setCallResult(input: {
		callId: string;
		result?: Record<string, unknown>;
		status: CallStatus;
	}): Promise<void>;
	startDispatch(input: {
		action: GitHubActionName;
		callId: string;
		invocation: InvocationContext;
	}): Promise<void>;
	revokeGrant(input: { grantId: string; principalId: string }): Promise<void>;
	rescheduleReconciliationJob(input: {
		callId: string;
		leaseId: string;
		reason: string;
	}): Promise<void>;
	verifyInvocation(
		input: InvocationContext & { action: GitHubActionName },
	): Promise<void>;
}

export interface GitHubExecutor {
	execute(input: {
		action: GitHubActionName;
		credential: CredentialForExecution;
		input: Record<string, unknown>;
	}): Promise<Record<string, unknown>>;
}

export interface GitHubReconciler {
	reconcile(input: {
		action: GitHubActionName;
		credential: CredentialForExecution;
		input: Record<string, unknown>;
	}): Promise<Record<string, unknown> | undefined>;
}

export interface GitHubOAuthProvider {
	getAuthorizationUrl(
		input: GitHubOAuthAuthorization & { redirectUri: string },
	): string;
	exchangeCode(input: {
		code: string;
		codeVerifier: string;
		redirectUri: string;
	}): Promise<GitHubOAuthIdentity>;
}

export class ConnectionError extends Error {
	constructor(
		readonly code:
			| "AUTHENTICATION_FAILED"
			| "FORBIDDEN"
			| "IDEMPOTENCY_CONFLICT"
			| "INVALID_REQUEST"
			| "PROVIDER_FAILED"
			| "PROVIDER_UNCERTAIN",
		message: string,
	) {
		super(message);
	}
}

export function normalizeSharedScopeDisplayName(value: string) {
	const displayName = value.trim();
	if (!displayName || displayName.length > 120) {
		throw new ConnectionError(
			"INVALID_REQUEST",
			"Shared group name is invalid",
		);
	}
	return displayName;
}

function assertRecord(
	value: unknown,
): asserts value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new ConnectionError(
			"INVALID_REQUEST",
			"Action arguments must be an object",
		);
	}
}

function assertNoSelectors(input: Record<string, unknown>) {
	for (const key of Object.keys(input)) {
		if (forbiddenSelectorNames.has(key)) {
			throw new ConnectionError(
				"INVALID_REQUEST",
				`Caller-supplied ${key} is not allowed`,
			);
		}
	}
}

function validateInput(action: ActionDefinition, value: unknown) {
	assertRecord(value);
	assertNoSelectors(value);
	let validator = actionValidators.get(action);
	if (!validator) {
		validator = new Validator(
			actionInputSchema(action) as Schema,
			"2020-12",
			false,
		);
		actionValidators.set(action, validator);
	}
	if (!validator.validate(value).valid) {
		throw new ConnectionError(
			"INVALID_REQUEST",
			"Input does not match the action schema",
		);
	}
	return { ...value };
}

function requestHash(action: GitHubActionName, input: Record<string, unknown>) {
	return canonicalHash({ action, input });
}

function delegatedRequestInput(input: Record<string, unknown>) {
	const { idempotencyKey: _idempotencyKey, ...args } = input;
	return args;
}

function actionService(actionVersionId: string) {
	return actionVersionId.split(".", 1)[0]?.toLowerCase() ?? "";
}

function publicActionId(action: ActionDefinition) {
	return action.id.replace(/@[^@]+$/, "");
}

export class ConnectionApplicationService {
	constructor(
		private readonly repository: ConnectionRepository,
		private readonly executor: GitHubExecutor,
		private readonly oauth?: GitHubOAuthProvider,
	) {}

	async overview(principalId: string) {
		return this.repository.getOverview(principalId);
	}

	isConnectionAdministrator(principalId: string) {
		return this.repository.isConnectionAdministrator(principalId);
	}

	authorizeConnectionAdministration(principalId: string) {
		return this.repository.authorizeConnectionAdministration(principalId);
	}

	grantConnectionAdministrator(input: {
		actorPrincipalId: string;
		targetPrincipalId: string;
	}) {
		return this.repository.grantConnectionAdministrator(input);
	}

	listConnectionAdministratorCandidates(principalId: string) {
		return this.repository.listConnectionAdministratorCandidates(principalId);
	}

	listConnectionAdministrators(principalId: string) {
		return this.repository.listConnectionAdministrators(principalId);
	}

	revokeConnectionAdministrator(input: {
		actorPrincipalId: string;
		targetPrincipalId: string;
	}) {
		return this.repository.revokeConnectionAdministrator(input);
	}

	createSharedScope(input: { actorPrincipalId: string; displayName: string }) {
		return this.repository.createSharedScope(input);
	}

	grantSharedScopePrincipal(input: {
		actorPrincipalId: string;
		sharedScopeId: string;
		targetPrincipalId: string;
	}) {
		return this.repository.grantSharedScopePrincipal(input);
	}

	revokeSharedScopePrincipal(input: {
		actorPrincipalId: string;
		sharedScopeId: string;
		targetPrincipalId: string;
	}) {
		return this.repository.revokeSharedScopePrincipal(input);
	}

	renameSharedScope(input: {
		actorPrincipalId: string;
		displayName: string;
		sharedScopeId: string;
	}) {
		return this.repository.renameSharedScope(input);
	}

	disconnectSharedConnection(input: {
		actorPrincipalId: string;
		connectionId: string;
	}) {
		return this.repository.disconnectSharedConnection(input);
	}

	sharedGithubAdministration(actorPrincipalId: string) {
		return this.repository.sharedGithubAdministration(actorPrincipalId);
	}

	storeSharedGithubOAuthCredential(input: {
		accessToken: string;
		actorPrincipalId: string;
		displayName: string;
		externalAccount: string;
		grantedScopes: readonly string[];
		sharedScopeId: string;
	}) {
		return this.repository.storeSharedGithubOAuthCredential(input);
	}

	async listDirectActions(session: string | undefined) {
		const invocation = await this.repository.resolveDirectSession(session);
		return this.repository.listAuthorizedActions(invocation);
	}

	async listDirectActionsForIdentity(input: {
		consumerId: string;
		instanceId: string;
		principalId: string;
	}) {
		return this.repository.listAuthorizedActions(
			await this.repository.resolveDirectIdentity(input),
		);
	}

	async listDirectAppsForIdentity(
		identity: { consumerId: string; instanceId: string; principalId: string },
		query?: string,
	) {
		const normalizedQuery = query?.toLowerCase() ?? "";
		const apps = new Map<string, number>();
		for (const action of await this.listDirectActionsForIdentity(identity)) {
			const service = actionService(action.id);
			if (normalizedQuery && !service.includes(normalizedQuery)) continue;
			apps.set(service, (apps.get(service) ?? 0) + 1);
		}
		return [...apps.entries()].map(([service, actionCount]) => ({
			actionCount,
			service,
		}));
	}

	async searchDirectActionsForIdentity(
		identity: { consumerId: string; instanceId: string; principalId: string },
		input: { limit?: number; query?: string; service?: string },
	) {
		const query = input.query?.toLowerCase() ?? "";
		const service = input.service?.toLowerCase() ?? "";
		const limit = Math.min(50, Math.max(1, input.limit ?? 20));
		return (await this.listDirectActionsForIdentity(identity))
			.filter((action) => {
				const matchesService = !service || actionService(action.id) === service;
				const haystack =
					`${action.id} ${action.name} ${action.description} ${action.effect}`.toLowerCase();
				return matchesService && (!query || haystack.includes(query));
			})
			.slice(0, limit)
			.map((action) => ({
				actionId: publicActionId(action),
				actionVersionId: action.id,
				description: action.description,
				effect: action.effect,
				name: action.name,
			}));
	}

	async getDirectActionGuideForIdentity(
		identity: { consumerId: string; instanceId: string; principalId: string },
		actionId: string,
	) {
		const action = await this.authorizedDirectAction(
			await this.repository.resolveDirectIdentity(identity),
			actionId,
		);
		const inputSchema = actionInputSchema(action);
		return {
			action: {
				actionId: publicActionId(action),
				actionVersionId: action.id,
				description: action.description,
				effect: action.effect,
				name: action.name,
				requiredScopes: action.requiredScopes,
			},
			guide: [
				`# ${action.name}`,
				"",
				action.description,
				"",
				`Effect: ${action.effect}`,
				"",
				"```json",
				JSON.stringify(inputSchema, null, 2),
				"```",
			].join("\n"),
			inputSchema,
		};
	}

	async listDirectConnectionsForIdentity(
		input: {
			consumerId: string;
			instanceId: string;
			principalId: string;
		},
		service?: string,
	) {
		const connections = await this.repository.listAuthorizedConnections(
			await this.repository.resolveDirectIdentity(input),
		);
		const normalizedService = service?.toLowerCase();
		return normalizedService
			? connections.filter((connection) =>
					connection.actionVersionIds.some(
						(actionVersionId) =>
							actionService(actionVersionId) === normalizedService,
					),
				)
			: connections;
	}

	async overviewDirect(session: string | undefined) {
		const invocation = await this.repository.resolveDirectSession(session);
		return this.repository.getOverview(invocation.principalId);
	}

	async invokeDirect(
		session: string | undefined,
		action: GitHubActionName,
		input: unknown,
	) {
		return this.invoke(
			await this.repository.resolveDirectSession(session),
			action,
			input,
		);
	}

	async invokeDirectForIdentity(
		identity: {
			consumerId: string;
			instanceId: string;
			principalId: string;
		},
		action: GitHubActionName,
		input: unknown,
	) {
		return this.invoke(
			await this.repository.resolveDirectIdentity(identity),
			action,
			input,
		);
	}

	async executeDirectActionForIdentity(
		identity: { consumerId: string; instanceId: string; principalId: string },
		actionId: string,
		input: unknown,
	) {
		const invocation = await this.repository.resolveDirectIdentity(identity);
		const action = await this.authorizedDirectAction(invocation, actionId);
		return this.invoke(invocation, action.name, input);
	}

	async createCurrentConsumerAuthorizationPreview(input: {
		connectionId: string;
		consumerId: string;
		principalId: string;
	}) {
		return this.repository.createCurrentConsumerAuthorizationPreview(input);
	}

	async confirmCurrentConsumerAuthorization(input: {
		confirmationToken: string;
		idempotencyKey: string;
		previewId: string;
		principalId: string;
	}) {
		return this.repository.confirmCurrentConsumerAuthorization(input);
	}

	async invokeDelegated(
		assertion:
			| (DelegatedAssertionBinding & { workload: string })
			| string
			| undefined,
		action: GitHubActionName,
		input: unknown,
		idempotencyKey?: string,
	) {
		const workload =
			typeof assertion === "string" || assertion === undefined
				? assertion
				: assertion.workload;
		const delegatedAssertion =
			typeof assertion === "object" ? assertion : undefined;
		assertRecord(input);
		if ("idempotencyKey" in input) {
			throw new ConnectionError(
				"INVALID_REQUEST",
				"Delegated calls use Idempotency-Key header",
			);
		}
		return this.invoke(
			await this.repository.resolveDelegatedWorkload(workload),
			action,
			idempotencyKey ? { ...input, idempotencyKey } : input,
			delegatedAssertion,
		);
	}

	async revokeGrant(principalId: string, grantId: string) {
		return this.repository.revokeGrant({ grantId, principalId });
	}

	async disconnectConnection(principalId: string, connectionId: string) {
		return this.repository.disconnectConnection({ connectionId, principalId });
	}

	async startGithubOAuth(principalId: string, redirectUri: string) {
		const oauth = this.requireOAuth();
		await this.repository.ensurePrincipal({ principalId });
		const state = randomToken();
		const codeVerifier = randomToken();
		const codeChallenge = base64UrlHash(codeVerifier);
		await this.repository.createOAuthTransaction({
			codeVerifier,
			principalId,
			redirectUri,
			state,
		});
		return {
			authorizationUrl: oauth.getAuthorizationUrl({
				codeChallenge,
				redirectUri,
				state,
			}),
		};
	}

	async startSharedGithubOAuth(
		actorPrincipalId: string,
		sharedScopeId: string,
		redirectUri: string,
	) {
		const oauth = this.requireOAuth();
		await this.repository.ensurePrincipal({ principalId: actorPrincipalId });
		const state = randomToken();
		const codeVerifier = randomToken();
		const codeChallenge = base64UrlHash(codeVerifier);
		await this.repository.createOAuthTransaction({
			codeVerifier,
			principalId: actorPrincipalId,
			redirectUri,
			sharedScopeId,
			state,
		});
		return {
			authorizationUrl: oauth.getAuthorizationUrl({
				codeChallenge,
				redirectUri,
				state,
			}),
		};
	}

	async completeGithubOAuth(code: string, state: string) {
		if (!code || !state) {
			throw new ConnectionError(
				"INVALID_REQUEST",
				"OAuth callback requires code and state",
			);
		}
		const transaction = await this.repository.consumeOAuthTransaction(state);
		const identity = await this.requireOAuth().exchangeCode({
			code,
			codeVerifier: transaction.codeVerifier,
			redirectUri: transaction.redirectUri,
		});
		return transaction.sharedScopeId
			? this.repository.storeSharedGithubOAuthCredential({
					...identity,
					actorPrincipalId: transaction.principalId,
					sharedScopeId: transaction.sharedScopeId,
				})
			: this.repository.storeGithubOAuthCredential({
					...identity,
					principalId: transaction.principalId,
				});
	}

	private requireOAuth(): GitHubOAuthProvider {
		if (!this.oauth) {
			throw new ConnectionError(
				"PROVIDER_FAILED",
				"GitHub OAuth is not configured",
			);
		}
		return this.oauth;
	}

	private async invoke(
		invocation: InvocationContext,
		action: GitHubActionName,
		value: unknown,
		delegatedAssertion?: DelegatedAssertionBinding,
	): Promise<CallProjection> {
		const actionDefinition = await this.authorizedActionDefinition(
			invocation,
			action,
		);
		const input = validateInput(actionDefinition, value);
		await this.repository.verifyInvocation({ ...invocation, action });
		const isMutating = actionDefinition.effect === "WRITE";
		const idempotencyKey =
			isMutating && typeof input.idempotencyKey === "string"
				? input.idempotencyKey
				: undefined;
		const argsHash =
			delegatedAssertion?.argsHash ??
			requestHash(
				action,
				delegatedAssertion ? delegatedRequestInput(input) : input,
			);
		if (idempotencyKey) {
			const existing = await this.repository.findIdempotentCall({
				action,
				idempotencyKey,
				invocation,
			});
			if (existing) {
				if (
					!canonicalHashMatches(
						{
							action,
							input: delegatedAssertion ? delegatedRequestInput(input) : input,
						},
						existing.argsHash,
					)
				) {
					throw new ConnectionError(
						"IDEMPOTENCY_CONFLICT",
						"Idempotency key was already used with different arguments",
					);
				}
				return projectCall(existing);
			}
		}
		const claimed = await this.repository.createCall({
			action,
			actionVersionId: delegatedAssertion?.actionVersionId,
			argsHash,
			delegatedAssertion,
			idempotencyKey,
			input,
			invocation,
		});
		const call = claimed.call;
		if (!claimed.created) {
			if (
				!canonicalHashMatches(
					{
						action,
						input: delegatedAssertion ? delegatedRequestInput(input) : input,
					},
					call.argsHash,
				)
			) {
				throw new ConnectionError(
					"IDEMPOTENCY_CONFLICT",
					"Idempotency key was already used with different arguments",
				);
			}
			return projectCall(call);
		}
		let providerResponded = false;
		let submissionStarted = false;
		try {
			const credential = await this.repository.getCredential(invocation);
			await this.repository.verifyInvocation({ ...invocation, action });
			if (isMutating) {
				await this.repository.startDispatch({
					action,
					callId: call.callId,
					invocation,
				});
				submissionStarted = true;
			}
			const result = await this.executor.execute({
				action,
				credential,
				input: delegatedRequestInput(input),
			});
			providerResponded = true;
			await this.repository.setCallResult({
				callId: call.callId,
				result,
				status: "SUCCEEDED",
			});
			return projectCall({ ...call, result, status: "SUCCEEDED" });
		} catch (error) {
			const status =
				isMutating &&
				(providerResponded ||
					submissionStarted ||
					(error instanceof ConnectionError &&
						error.code === "PROVIDER_UNCERTAIN") ||
					isSubmissionUncertain(error))
					? "UNCERTAIN"
					: error instanceof ConnectionError && error.code === "FORBIDDEN"
						? "DENIED_LOCAL"
						: "FAILED";
			try {
				await this.repository.setCallResult({ callId: call.callId, status });
			} catch {
				if (!providerResponded && !submissionStarted) throw error;
			}
			if (isMutating && providerResponded) {
				throw new ConnectionError(
					"PROVIDER_UNCERTAIN",
					"Provider responded but Connection could not persist the terminal result",
				);
			}
			if (status === "UNCERTAIN") {
				throw new ConnectionError(
					"PROVIDER_UNCERTAIN",
					"GitHub write submission outcome is unknown; reconciliation is pending",
				);
			}
			if (error instanceof ConnectionError) {
				throw error;
			}
			throw new ConnectionError(
				"PROVIDER_FAILED",
				"GitHub provider request failed",
			);
		}
	}

	private async authorizedActionDefinition(
		invocation: InvocationContext,
		action: ActionName,
	) {
		const definition = (
			await this.repository.listAuthorizedActions(invocation)
		).find((entry) => entry.name === action);
		if (!definition) {
			throw new ConnectionError(
				"FORBIDDEN",
				"Connection authorization is not active",
			);
		}
		return definition;
	}

	private async authorizedDirectAction(
		invocation: InvocationContext,
		actionId: string,
	) {
		const action = (
			await this.repository.listAuthorizedActions(invocation)
		).find(
			(candidate) =>
				candidate.id === actionId ||
				candidate.name === actionId ||
				publicActionId(candidate) === actionId,
		);
		if (!action) {
			throw new ConnectionError(
				"INVALID_REQUEST",
				"Unknown or unauthorized action",
			);
		}
		return action;
	}
}

export class ConnectionRecoveryService {
	constructor(
		private readonly repository: ConnectionRepository,
		private readonly reconciler: GitHubReconciler,
	) {}

	async runOnce(): Promise<boolean> {
		const job = await this.repository.claimReconciliationJob();
		if (!job) return false;
		try {
			const result = await this.reconciler.reconcile({
				action: job.action,
				credential: await this.repository.getCredential(job.invocation),
				input: job.input,
			});
			if (result) {
				await this.repository.completeReconciliationJob({
					callId: job.callId,
					leaseId: job.leaseId,
					result,
				});
			} else {
				await this.repository.rescheduleReconciliationJob({
					callId: job.callId,
					leaseId: job.leaseId,
					reason: "Provider evidence is not yet available",
				});
			}
		} catch (error) {
			await this.repository.rescheduleReconciliationJob({
				callId: job.callId,
				leaseId: job.leaseId,
				reason:
					error instanceof Error ? error.message : "Reconciliation failed",
			});
		}
		return true;
	}
}

function isSubmissionUncertain(error: unknown) {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { submissionUncertain?: unknown }).submissionUncertain === true
	);
}

function randomToken() {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
		"base64url",
	);
}

function base64UrlHash(value: string) {
	return createHash("sha256").update(value).digest("base64url");
}
