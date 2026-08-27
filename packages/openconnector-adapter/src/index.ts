import type {
	ActionDefinition,
	CredentialForExecution,
	GitHubActionName,
	GitHubExecutor,
	GitHubOAuthAuthorization,
	GitHubOAuthIdentity,
	GitHubOAuthProvider,
	GitHubReconciler,
} from "@agent-infra/connection-core";
import {
	type ExecutionContext,
	type ExecutionResult,
	executeAction,
	githubActions,
	githubExecutors,
	githubProvider,
	type ResolvedCredential,
	requestAuthorizationCodeToken,
} from "@agent-infra/openconnector-kernel";

export * from "./bitbucket-server.ts";

import { githubExecutorDigest } from "./github-integrity.ts";

const githubSourceCommit = "0cb0e0dd2ed686fa7fa2ff8d9eef97a7d6b31674";

/**
 * Connection's catalog projection is generated from the OpenConnector kernel.
 * A new kernel action therefore needs no Connection MCP wrapper or hand-copied
 * schema. Unknown verbs default to WRITE so a new mutating action fails closed
 * until its provider declaration is reviewed.
 */
function connectionEffect(name: string): ActionDefinition["effect"] {
	const readVerbs = new Set(["check", "compare", "get", "list", "search"]);
	return readVerbs.has(name.split("_", 1)[0] ?? "") ? "READ" : "WRITE";
}

export const githubConnectionCatalog = {
	authProfile: {
		type: "oauth2",
		tokenTransport: "bearer",
	},
	deploymentProfile: {
		apiOrigin: "https://api.github.com",
		deployment: "cloud",
		product: "GitHub",
	},
	executorDigest: githubExecutorDigest,
	provider: "github",
	providerReleaseId: `github-openconnector-${githubSourceCommit}-connection-v6`,
	sourceCommit: githubSourceCommit,
	actions: githubActions.map((action) => ({
		description: action.description,
		effect: connectionEffect(action.name),
		id: `${action.id}@v5`,
		inputSchema: connectionInputSchema(action.inputSchema),
		name: action.id,
		requiredScopes: [...action.requiredScopes],
	})),
} as const;

const defaultPublishedGitHubActions: readonly GitHubActionName[] =
	githubConnectionCatalog.actions.map((action) => action.name);

function connectionInputSchema(inputSchema: Record<string, unknown>) {
	const required = Array.isArray(inputSchema.required)
		? inputSchema.required.filter(
				(entry): entry is string => typeof entry === "string",
			)
		: [];
	return { ...inputSchema, required };
}

type GitHubOAuthAdapterOptions = {
	clientId: string;
	clientSecret: string;
	authorizationUrl?: string;
	tokenUrl?: string;
	publishedActions?: readonly GitHubActionName[];
};

export class OpenConnectorGitHubAdapter
	implements GitHubExecutor, GitHubReconciler
{
	async execute(input: {
		action: GitHubActionName;
		credential: CredentialForExecution;
		input: Record<string, unknown>;
	}) {
		return runKernelAction(
			input.action,
			toKernelInput(input.input),
			input.credential,
		);
	}

	async reconcile(input: {
		action: GitHubActionName;
		credential: CredentialForExecution;
		input: Record<string, unknown>;
	}) {
		if (toKernelActionName(input.action) !== "create_pull_request")
			return undefined;
		const value = toKernelInput(input.input);
		const result = await runKernelAction(
			"github.list_pull_requests",
			{
				base: value.base,
				head: value.head,
				owner: value.owner,
				repo: value.repo,
				state: "open",
			},
			input.credential,
		);
		const pullRequests = result.pull_requests;
		if (!Array.isArray(pullRequests)) return undefined;
		return pullRequests.find((entry) => {
			if (typeof entry !== "object" || entry === null) return false;
			const pullRequest = entry as {
				title?: unknown;
				base?: { ref?: unknown };
				head?: { ref?: unknown };
			};
			return (
				pullRequest.title === value.title &&
				pullRequest.base?.ref === value.base &&
				pullRequest.head?.ref === value.head
			);
		}) as Record<string, unknown> | undefined;
	}
}

export class OpenConnectorGitHubOAuthAdapter implements GitHubOAuthProvider {
	private readonly options: GitHubOAuthAdapterOptions;

	constructor(options: GitHubOAuthAdapterOptions) {
		this.options = options;
	}

	getAuthorizationUrl(
		input: GitHubOAuthAuthorization & { redirectUri: string },
	) {
		const auth = githubOAuthDefinition();
		const url = new URL(this.options.authorizationUrl ?? auth.authorizationUrl);
		url.searchParams.set("client_id", this.options.clientId);
		url.searchParams.set("code_challenge", input.codeChallenge);
		url.searchParams.set("code_challenge_method", "S256");
		url.searchParams.set("redirect_uri", input.redirectUri);
		url.searchParams.set("response_type", "code");
		url.searchParams.set(
			"scope",
			githubScopesForActions(
				this.options.publishedActions ?? defaultPublishedGitHubActions,
			).join(" "),
		);
		url.searchParams.set("state", input.state);
		return url.toString();
	}

	async exchangeCode(input: {
		code: string;
		codeVerifier: string;
		redirectUri: string;
	}): Promise<GitHubOAuthIdentity> {
		const auth = githubOAuthDefinition();
		const credential = await requestAuthorizationCodeToken({
			code: input.code,
			clientId: this.options.clientId,
			clientSecret: this.options.clientSecret,
			redirectUri: input.redirectUri,
			extraFields: { code_verifier: input.codeVerifier },
			responseEnvelope: auth.tokenResponseEnvelope,
			tokenRequestFields: auth.tokenRequestFields,
			tokenEndpointAuthMethod: auth.tokenEndpointAuthMethod,
			tokenRequestFormat: auth.tokenRequestFormat,
			tokenUrl: this.options.tokenUrl ?? auth.tokenUrl,
			createError: (message) => new Error(message),
		});
		const user = await runKernelAction(
			"github.getCurrentUser",
			{},
			{ accessToken: credential.accessToken },
		);
		const externalAccount =
			user.id === undefined || user.id === null ? undefined : String(user.id);
		if (!externalAccount) {
			throw new Error("GitHub OAuth profile lookup failed");
		}
		const displayName =
			typeof user.name === "string" && user.name.trim()
				? user.name.trim()
				: typeof user.login === "string" && user.login.trim()
					? user.login.trim()
					: externalAccount;
		const grantedScopes =
			typeof credential.metadata.scope === "string"
				? credential.metadata.scope
						.split(/[\s,]+/)
						.map((scope) => scope.trim())
						.filter(Boolean)
				: [];
		if (grantedScopes.length === 0) {
			throw new Error("GitHub OAuth response did not prove granted scopes");
		}
		return {
			accessToken: credential.accessToken,
			displayName,
			externalAccount,
			grantedScopes: [...new Set(grantedScopes)].sort(),
		};
	}
}

async function runKernelAction(
	action: GitHubActionName | "github.listPullRequests",
	input: Record<string, unknown>,
	credential: CredentialForExecution,
): Promise<Record<string, unknown>> {
	const kernelActionName = toKernelActionName(action);
	const actionDefinition = githubActions.find(
		(entry) => entry.name === kernelActionName,
	);
	const executor =
		githubExecutors[
			`github.${kernelActionName}` as keyof typeof githubExecutors
		];
	if (!actionDefinition || !executor) {
		throw new Error(
			`OpenConnector action is not available: ${kernelActionName}`,
		);
	}
	const context: ExecutionContext = {
		getCredential: async (service) =>
			service === "github" ? toKernelCredential(credential) : undefined,
	};
	const result = await executeAction(
		actionDefinition,
		executor,
		input,
		context,
	);
	return unwrapResult(result, kernelActionName);
}

function githubOAuthDefinition() {
	const auth = githubProvider.auth.find((entry) => entry.type === "oauth2");
	if (auth?.type !== "oauth2") {
		throw new Error("OpenConnector GitHub OAuth definition is unavailable");
	}
	return auth;
}

function githubScopesForActions(actions: readonly GitHubActionName[]) {
	const scopes = new Set<string>(["read:user"]);
	for (const action of actions) {
		const kernelActionName = toKernelActionName(action);
		const definition = githubActions.find(
			(entry) => entry.name === kernelActionName,
		);
		if (!definition) {
			throw new Error(
				`OpenConnector action is not available: ${kernelActionName}`,
			);
		}
		for (const scope of definition.requiredScopes) scopes.add(scope);
	}
	return [...scopes];
}

function toKernelInput(
	input: Record<string, unknown>,
): Record<string, unknown> {
	const {
		idempotencyKey: _idempotencyKey,
		repository,
		...providerInput
	} = input;
	if (typeof repository !== "string") return providerInput;
	const separator = repository.indexOf("/");
	if (separator <= 0 || separator === repository.length - 1) {
		throw new Error("repository must be in owner/name form");
	}
	return {
		...providerInput,
		owner: repository.slice(0, separator),
		repo: repository.slice(separator + 1),
	};
}

function toKernelActionName(action: string) {
	const localName = action.startsWith("github.")
		? action.slice("github.".length)
		: action;
	return localName.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function toKernelCredential(
	credential: CredentialForExecution,
): ResolvedCredential {
	return {
		authType: "oauth2",
		accessToken: credential.accessToken,
		tokenType: "Bearer",
		metadata: {},
		profile: {
			accountId: "github",
			displayName: "GitHub",
			grantedScopes: [],
		},
	};
}

function unwrapResult(
	result: ExecutionResult,
	kernelActionName: string,
): Record<string, unknown> {
	if (!result.ok) {
		const error = Object.assign(
			new Error(
				result.error?.message ?? "OpenConnector provider request failed",
			),
			{ providerCode: result.error?.code },
		);
		if (
			kernelActionName === "create_pull_request" &&
			result.error?.code === "provider_error"
		) {
			Object.assign(error, { submissionUncertain: true });
		}
		throw error;
	}
	if (
		typeof result.output !== "object" ||
		result.output === null ||
		Array.isArray(result.output)
	) {
		throw new Error(
			`OpenConnector action returned invalid output: ${kernelActionName}`,
		);
	}
	return result.output as Record<string, unknown>;
}
