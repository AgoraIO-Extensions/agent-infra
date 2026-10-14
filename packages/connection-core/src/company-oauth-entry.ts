import {
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import {
	type CompanyOAuthCommands,
	companyIdentityCallbackPath,
} from "./company-identity-probe";
import { OAuthProtocolError } from "./oauth";

export const companyEntryPath = "/api/v1/connection/identity/oauth/entry";
export const companyEntryCheckPath = `${companyEntryPath}/check`;
export const companyEntryStateTtl = 300;
export const companyEntryTtl = 1800;

function rejected(): never {
	throw new OAuthProtocolError(
		"invalid_request",
		"Company OAuth entrance rejected",
	);
}

const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");

// Admission only: this class never resolves a Principal or grants business access.
export class CompanyOAuthEntry {
	private readonly key: Buffer;
	readonly redirectUri: string;
	constructor(
		private readonly options: {
			clientId: string;
			commands: CompanyOAuthCommands;
			identityKey: Uint8Array;
			identityRealm: string;
			publicBaseUrl: string;
			readIdentity: (code: string, redirectUri: string) => Promise<unknown>;
		},
	) {
		if (new URL(options.publicBaseUrl).protocol !== "https:") rejected();
		this.redirectUri = new URL(
			companyIdentityCallbackPath,
			options.publicBaseUrl,
		).href;
		this.key = createHmac("sha256", options.identityKey)
			.update(
				`company-oauth-entrance-v1\0${options.identityRealm}\0${options.clientId}\0${this.redirectUri}`,
			)
			.digest();
	}

	returnTo(value = "/connection/connections") {
		if (
			value.length > 1536 ||
			!value.startsWith("/") ||
			value.startsWith("//") ||
			value.includes("\\") ||
			[...value].some((character) => character.charCodeAt(0) <= 32)
		)
			rejected();
		const url = new URL(value, this.options.publicBaseUrl);
		if (url.origin !== new URL(this.options.publicBaseUrl).origin || url.hash)
			rejected();
		const page =
			/^\/connection\/(?:login|connections|tokens|approvals|admin\/[a-z-]+)$/.test(
				url.pathname,
			);
		const binding =
			/^\/connection\/pat-bindings\/[A-Za-z0-9_-]+$/.test(url.pathname) &&
			!url.pathname.endsWith("/confirm");
		if (!page && !binding && url.pathname !== "/oauth/authorize") rejected();
		return `${url.pathname}${url.search}`;
	}

	start(returnTo?: string) {
		const state = `entry.${this.seal({
			purpose: "state",
			expires: Date.now() + companyEntryStateTtl * 1000,
			nonce: randomBytes(32).toString("base64url"),
			returnTo: this.returnTo(returnTo),
		})}`;
		const url = new URL("https://oauth.agoralab.co/oauth/authorize");
		url.search = new URLSearchParams({
			client_id: this.options.clientId,
			redirect_uri: this.redirectUri,
			response_type: "code",
			scope: "read",
			state,
		}).toString();
		return { state, authorizationUrl: url.href };
	}

	validateCallback(state: string, cookie: string | undefined, code: string) {
		if (
			!cookie ||
			cookie !== state ||
			!state.startsWith("entry.") ||
			code.length < 1 ||
			code.length > 2048 ||
			/[^\x21-\x7e]/.test(code)
		)
			rejected();
		const value = this.open(state.slice(6), companyEntryStateTtl);
		if (
			value.purpose !== "state" ||
			typeof value.returnTo !== "string" ||
			typeof value.nonce !== "string" ||
			!/^[A-Za-z0-9_-]{43}$/.test(value.nonce)
		)
			rejected();
		return this.returnTo(value.returnTo);
	}

	async complete(input: {
		state: string;
		cookie: string | undefined;
		code: string;
	}) {
		const returnTo = this.validateCallback(
			input.state,
			input.cookie,
			input.code,
		);
		return this.options.commands.execute(
			{
				idempotencyKey: hash(input.state),
				operation: "connection.company-oauth-entry.complete",
				replayable: false,
				request: { stateHash: hash(input.state), codeHash: hash(input.code) },
				subject: `company-entry:${hash(input.state)}`,
			},
			async () => {
				try {
					const raw = await this.options.readIdentity(
						input.code,
						this.redirectUri,
					);
					if (!raw || typeof raw !== "object" || Array.isArray(raw)) rejected();
					const profile = raw as Record<string, unknown>;
					if (
						profile.error ||
						profile.active === false ||
						profile.enabled === false ||
						(profile.code !== undefined &&
							profile.code !== 0 &&
							profile.code !== 200)
					)
						rejected();
					// This is an admission profile, never a join to an LDAP account.
					const emails = [profile.email, profile.notifyemail].filter(
						(v): v is string => typeof v === "string",
					);
					if (
						!emails.some(
							(v) =>
								v.length <= 320 &&
								!/\s/.test(v) &&
								/^[^\s@]+@(agora\.io|shengwang\.cn)$/i.test(v),
						)
					)
						rejected();
					return {
						returnTo,
						ticket: this.seal({
							purpose: "admission",
							expires: Date.now() + companyEntryTtl * 1000,
							nonce: randomBytes(32).toString("base64url"),
						}),
					};
				} catch {
					throw new Error(
						"Company OAuth entrance failed; start a new authorization",
					);
				}
			},
		);
	}

	admitted(ticket: string | undefined) {
		if (!ticket) return false;
		try {
			const value = this.open(ticket, companyEntryTtl);
			return (
				value.purpose === "admission" &&
				typeof value.nonce === "string" &&
				/^[A-Za-z0-9_-]{43}$/.test(value.nonce) &&
				value.returnTo === undefined
			);
		} catch {
			return false;
		}
	}

	private seal(value: Record<string, unknown>) {
		const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
		return `${payload}.${this.sign(payload)}`;
	}
	private sign(value: string) {
		return createHmac("sha256", this.key).update(value).digest("base64url");
	}
	private open(value: string, ttl: number): Record<string, unknown> {
		if (
			value.trim() !== value ||
			!/^[A-Za-z0-9_-]{1,3000}\.[A-Za-z0-9_-]{43}$/.test(value)
		)
			rejected();
		const [payload, signature] = value.split(".");
		if (
			!payload ||
			!signature ||
			!timingSafeEqual(Buffer.from(signature), Buffer.from(this.sign(payload)))
		)
			rejected();
		try {
			const parsed = JSON.parse(Buffer.from(payload, "base64url").toString());
			if (
				!parsed ||
				typeof parsed !== "object" ||
				!Number.isSafeInteger(parsed.expires) ||
				parsed.expires <= Date.now() ||
				parsed.expires > Date.now() + ttl * 1000
			)
				rejected();
			return parsed;
		} catch {
			return rejected();
		}
	}
}
