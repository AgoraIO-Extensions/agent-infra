import {
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import { type ConnectionOAuthService, OAuthProtocolError } from "./oauth";

export const companyIdentityCallbackPath =
	"/api/v1/connection/identity/oauth/callback";
export const companyIdentityProbePath =
	"/api/v1/connection/identity/oauth/probe";
export const companyIdentityProbeTtlSeconds = 300;

type Commands = {
	execute<T>(
		input: {
			idempotencyKey: string;
			operation: string;
			replayable: boolean;
			request: unknown;
			subject: string;
		},
		command: () => Promise<T>,
	): Promise<T>;
};

function invalid(): never {
	throw new OAuthProtocolError(
		"invalid_request",
		"Identity probe is unavailable",
	);
}

function hash(value: string) {
	return createHash("sha256").update(value).digest("hex");
}

export class CompanyIdentityProbe {
	private readonly key: Buffer;
	readonly redirectUri: string;

	constructor(
		private readonly options: {
			clientId: string;
			commands: Commands;
			identityKey: Uint8Array;
			identityRealm: string;
			isAdministrator: (principalId: string) => Promise<boolean>;
			oauth: ConnectionOAuthService;
			publicBaseUrl: string;
			readIdentity: (code: string, redirectUri: string) => Promise<unknown>;
		},
	) {
		this.key = createHmac("sha256", options.identityKey)
			.update(`company-identity-probe-v1\0${options.identityRealm}`)
			.digest();
		this.redirectUri = new URL(
			companyIdentityCallbackPath,
			options.publicBaseUrl,
		).toString();
	}

	async requireAdministrator(sessionToken: string | undefined) {
		const account = await this.options.oauth.getBrowserAccount(sessionToken);
		if (!(await this.options.isAdministrator(account.principalId))) {
			throw new OAuthProtocolError(
				"access_denied",
				"Identity probe is unavailable",
				403,
			);
		}
		return account;
	}

	async start(sessionToken: string | undefined) {
		await this.requireAdministrator(sessionToken);
		if (!sessionToken) invalid();
		const payload = Buffer.from(
			JSON.stringify({
				expires: Date.now() + companyIdentityProbeTtlSeconds * 1_000,
				nonce: randomBytes(32).toString("base64url"),
				session: hash(sessionToken),
			}),
		).toString("base64url");
		const state = `${payload}.${this.sign(payload)}`;
		const url = new URL("https://oauth.agoralab.co/oauth/authorize");
		url.search = new URLSearchParams({
			client_id: this.options.clientId,
			redirect_uri: this.redirectUri,
			response_type: "code",
			scope: "read",
			state,
		}).toString();
		return { authorizationUrl: url.toString(), state };
	}

	validateCallback(state: string, cookie: string | undefined, code: string) {
		if (!cookie || cookie !== state || !/^[\x21-\x7e]{1,2048}$/.test(code))
			invalid();
		return this.readState(state);
	}

	async complete(input: {
		code: string;
		cookie: string | undefined;
		sessionToken: string | undefined;
		state: string;
	}) {
		const state = this.validateCallback(input.state, input.cookie, input.code);
		const account = await this.requireAdministrator(input.sessionToken);
		if (!input.sessionToken || state.session !== hash(input.sessionToken))
			invalid();
		return this.options.commands.execute(
			{
				idempotencyKey: hash(input.state),
				operation: "connection.identity-probe.complete",
				replayable: false,
				request: { codeHash: hash(input.code), stateHash: hash(input.state) },
				subject: account.principalId,
			},
			async () => {
				try {
					const raw = await this.options.readIdentity(
						input.code,
						this.redirectUri,
					);
					if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid();
					// Recheck revocation after the network round trip before returning evidence.
					await this.requireAdministrator(input.sessionToken);
					return this.options.oauth.inspectCompanyIdentity(
						input.sessionToken,
						raw as Record<string, unknown>,
					);
				} catch {
					// A code submission cannot be proven unconsumed on timeout or failure.
					// Keep the durable STARTED record; never re-exchange this transaction.
					throw new Error("Identity probe failed; start a new authorization");
				}
			},
		);
	}

	private sign(payload: string) {
		return createHmac("sha256", this.key).update(payload).digest("base64url");
	}

	private readState(state: string): { expires: number; session: string } {
		if (!/^[A-Za-z0-9_-]{1,600}\.[A-Za-z0-9_-]{43}$/.test(state)) invalid();
		const [payload, signature] = state.split(".");
		if (!payload || !signature) invalid();
		if (
			!timingSafeEqual(Buffer.from(signature), Buffer.from(this.sign(payload)))
		)
			invalid();
		try {
			const value = JSON.parse(Buffer.from(payload, "base64url").toString());
			if (
				!Number.isSafeInteger(value.expires) ||
				value.expires <= Date.now() ||
				value.expires > Date.now() + companyIdentityProbeTtlSeconds * 1_000 ||
				!/^\w{64}$/.test(value.session) ||
				!/^[A-Za-z0-9_-]{43}$/.test(value.nonce)
			)
				invalid();
			return value;
		} catch {
			return invalid();
		}
	}
}
