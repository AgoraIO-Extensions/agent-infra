import {
	LoginRateLimitedError,
	type LoginThrottleOutcome,
	normalizeLoginAccount,
} from "./login-throttle.js";
import type { PrincipalIdentityInput } from "./principal.js";
import type {
	BrowserSessionPrincipal,
	BrowserSessionService,
} from "./session.js";
import { PrincipalInactiveError } from "./session.js";

export class LoginRejectedError extends Error {
	constructor() {
		super("Login failed");
		this.name = "LoginRejectedError";
	}
}

export class LoginUnavailableError extends Error {
	constructor() {
		super("Login unavailable");
		this.name = "LoginUnavailableError";
	}
}

export interface LoginAuditEvent {
	principalId?: string;
	action: "auth.login" | "auth.logout";
	outcome: "succeeded" | "rejected" | "failed";
	environment: string;
	accountMarker?: string;
	sourceMarker?: string;
}

export interface ConnectionLoginDependencies {
	authenticator: {
		authenticate(
			username: string,
			password: string,
		): Promise<PrincipalIdentityInput>;
	};
	principals: {
		resolve(input: PrincipalIdentityInput): Promise<BrowserSessionPrincipal>;
	};
	sessions: Pick<BrowserSessionService, "create" | "resolve" | "revoke">;
	throttle: {
		begin(input: {
			environment: string;
			sourceMarker: string;
			accountMarker: string;
		}): Promise<(outcome: LoginThrottleOutcome) => Promise<void>>;
	};
	audit: (event: LoginAuditEvent) => Promise<void>;
	marker: (kind: "account" | "source", value: string) => string;
	environment: string;
	failureFloorMs: number;
}

export class ConnectionLoginService {
	constructor(private readonly dependencies: ConnectionLoginDependencies) {
		if (
			!dependencies.environment ||
			!Number.isInteger(dependencies.failureFloorMs) ||
			dependencies.failureFloorMs < 0 ||
			dependencies.failureFloorMs > 60_000
		)
			throw new Error("Connection login configuration is invalid");
	}

	private async padFailure(startedAt: number): Promise<void> {
		const remaining =
			this.dependencies.failureFloorMs - (Date.now() - startedAt);
		if (remaining > 0)
			await new Promise((resolve) => setTimeout(resolve, remaining));
	}

	async login(input: { username: string; password: string; source: string }) {
		let expired = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(
				() => {
					expired = true;
					reject(new LoginUnavailableError());
				},
				Math.max(1_000, this.dependencies.failureFloorMs + 250),
			);
		});
		try {
			return await Promise.race([
				this.performLogin(input, () => expired),
				deadline,
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private async performLogin(
		input: { username: string; password: string; source: string },
		expired: () => boolean,
	) {
		if (!input.source.trim()) throw new LoginUnavailableError();
		const startedAt = Date.now();
		const audit = {
			action: "auth.login" as const,
			environment: this.dependencies.environment,
			accountMarker: this.dependencies.marker(
				"account",
				normalizeLoginAccount(input.username),
			),
			sourceMarker: this.dependencies.marker("source", input.source),
		};
		if (
			!/^[a-f0-9]{64}$/.test(audit.accountMarker) ||
			!/^[a-f0-9]{64}$/.test(audit.sourceMarker)
		)
			throw new LoginUnavailableError();
		let finish: (outcome: LoginThrottleOutcome) => Promise<void>;
		try {
			finish = await this.dependencies.throttle.begin({
				environment: this.dependencies.environment,
				sourceMarker: audit.sourceMarker,
				accountMarker: audit.accountMarker,
			});
		} catch (error) {
			if (!(error instanceof LoginRateLimitedError))
				throw new LoginUnavailableError();
			try {
				await this.dependencies.audit({ ...audit, outcome: "rejected" });
			} catch {
				throw new LoginUnavailableError();
			}
			throw error;
		}
		let created:
			| Awaited<ReturnType<BrowserSessionService["create"]>>
			| undefined;
		try {
			if (expired()) throw new LoginUnavailableError();
			const identity = await this.dependencies.authenticator.authenticate(
				input.username,
				input.password,
			);
			if (expired()) throw new LoginUnavailableError();
			const principal = await this.dependencies.principals.resolve(identity);
			if (principal.status !== "active") throw new PrincipalInactiveError();
			if (expired()) throw new LoginUnavailableError();
			created = await this.dependencies.sessions.create(principal);
			if (expired()) throw new LoginUnavailableError();
			await this.dependencies.audit({
				...audit,
				principalId: principal.id,
				outcome: "succeeded",
			});
			if (expired()) throw new LoginUnavailableError();
			await finish("succeeded");
			if (expired()) throw new LoginUnavailableError();
			return { principal, ...created };
		} catch (error) {
			let failure = error;
			const rejected =
				error instanceof LoginRejectedError ||
				error instanceof PrincipalInactiveError;
			try {
				await finish(rejected ? "rejected" : "unavailable");
			} catch {
				failure = new LoginUnavailableError();
			}
			if (created)
				await this.dependencies.sessions.revoke(created.token).catch(() => {});
			try {
				await this.dependencies.audit({ ...audit, outcome: "failed" });
			} catch {
				throw new LoginUnavailableError();
			}
			if (
				failure instanceof LoginRejectedError ||
				failure instanceof PrincipalInactiveError
			) {
				await this.padFailure(startedAt);
				if (
					expired() ||
					Date.now() - startedAt > this.dependencies.failureFloorMs + 100
				)
					throw new LoginUnavailableError();
				throw new LoginRejectedError();
			}
			throw new LoginUnavailableError();
		}
	}

	currentSession(token: string | undefined) {
		return this.dependencies.sessions.resolve(token);
	}

	async logout(token: string): Promise<BrowserSessionPrincipal | undefined> {
		const principal = await this.dependencies.sessions.resolve(token);
		if (!principal) return undefined;
		await this.dependencies.sessions.revoke(token);
		await this.dependencies.audit({
			action: "auth.logout",
			principalId: principal.id,
			environment: this.dependencies.environment,
			outcome: "succeeded",
		});
		return principal;
	}
}
