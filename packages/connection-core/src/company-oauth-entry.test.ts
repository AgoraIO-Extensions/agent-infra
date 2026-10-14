import { describe, expect, it, vi } from "vitest";
import { CompanyOAuthEntry } from "./company-oauth-entry";

function entrance(realm = "urn:test:entry", clientId = "entry-client") {
	const seen = new Set<string>();
	const readIdentity = vi.fn(
		async (): Promise<unknown> => ({
			email: "employee@agora.io",
			permissions: ["CONNECTION_ADMIN"],
		}),
	);
	const requests: unknown[] = [];
	const gate = new CompanyOAuthEntry({
		clientId,
		identityKey: Buffer.alloc(32, 29),
		identityRealm: realm,
		publicBaseUrl: "https://connection.example/",
		readIdentity,
		commands: {
			execute: async (input, command) => {
				requests.push(input);
				if (seen.has(input.idempotencyKey)) throw new Error("Taken");
				seen.add(input.idempotencyKey);
				return command();
			},
		},
	});
	return { gate, readIdentity, requests };
}

describe("company OAuth entrance, independent from LDAP", () => {
	it("binds browser/state, consumes once, and never puts company identity in the admission ticket", async () => {
		const { gate, readIdentity, requests } = entrance();
		const target =
			"/oauth/authorize?client_id=codex&state=consumer-state&resource=https%3A%2F%2Fconnection.example%2Fmcp";
		const { state, authorizationUrl } = gate.start(target);
		const url = new URL(authorizationUrl);
		expect(url.origin).toBe("https://oauth.agoralab.co");
		expect(url.searchParams.get("redirect_uri")).toBe(
			"https://connection.example/api/v1/connection/identity/oauth/callback",
		);
		expect(() =>
			gate.validateCallback(state, undefined, "synthetic-code"),
		).toThrow();
		expect(() =>
			gate.validateCallback(state, gate.start().state, "synthetic-code"),
		).toThrow();
		expect(() => gate.validateCallback(state, state, "code\n")).toThrow();
		expect(gate.admitted(state.slice(6))).toBe(false);
		const result = await gate.complete({
			state,
			cookie: state,
			code: "synthetic-code",
		});
		expect(result.returnTo).toBe(target);
		expect(gate.admitted(result.ticket)).toBe(true);
		expect(entrance("other-realm").gate.admitted(result.ticket)).toBe(false);
		expect(
			entrance("urn:test:entry", "other-client").gate.admitted(result.ticket),
		).toBe(false);
		expect(() =>
			gate.validateCallback(
				`entry.${result.ticket}`,
				`entry.${result.ticket}`,
				"synthetic-code",
			),
		).toThrow();
		expect(
			Buffer.from(result.ticket.split(".")[0] ?? "", "base64url").toString(),
		).not.toMatch(/employee|agora\.io|permissions|CONNECTION_ADMIN/);
		expect(JSON.stringify(requests)).not.toContain("synthetic-code");
		await expect(
			gate.complete({ state, cookie: state, code: "synthetic-code" }),
		).rejects.toThrow();
		expect(readIdentity).toHaveBeenCalledTimes(1);
	});

	it("rejects expiry, tampering, cross-realm states and unsafe recovery destinations", async () => {
		vi.useFakeTimers();
		try {
			const { gate } = entrance();
			for (const target of [
				"https://attacker.invalid/",
				"//attacker.invalid/",
				"/mcp",
				"/oauth/token",
				"/connection/login#fragment",
				"/connection/../oauth/token",
				"/connection/pat-bindings/confirm",
				"/connection/login\\evil",
				"/connection/login\r\nX: value",
			])
				expect(() => gate.start(target)).toThrow();
			const { state } = gate.start();
			expect(() =>
				entrance("other").gate.validateCallback(state, state, "code"),
			).toThrow();
			expect(() =>
				gate.validateCallback(`${state}x`, `${state}x`, "code"),
			).toThrow();
			vi.advanceTimersByTime(300_001);
			expect(() => gate.validateCallback(state, state, "code")).toThrow();
			const fresh = gate.start();
			const result = await gate.complete({
				state: fresh.state,
				cookie: fresh.state,
				code: "code",
			});
			vi.advanceTimersByTime(1800_001);
			expect(gate.admitted(result.ticket)).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("fails closed for malformed profiles and keeps failed/uncertain exchanges taken", async () => {
		for (const raw of [
			null,
			[],
			{},
			{ email: "employee@attacker.invalid" },
			{ email: "robot" },
			{ email: "employee@agora.io\n" },
			{ email: "employee@agora.io.attacker.invalid" },
			{ error: "denied", email: "employee@agora.io" },
			{ code: 401, email: "employee@agora.io" },
			{ active: false, email: "employee@agora.io" },
			{ enabled: false, email: "employee@agora.io" },
		]) {
			const { gate, readIdentity } = entrance();
			readIdentity.mockResolvedValueOnce(raw);
			const { state } = gate.start();
			await expect(
				gate.complete({ state, cookie: state, code: "code" }),
			).rejects.toThrow(/start a new/);
			await expect(
				gate.complete({ state, cookie: state, code: "code" }),
			).rejects.toThrow("Taken");
			expect(readIdentity).toHaveBeenCalledTimes(1);
		}
		const { gate, readIdentity } = entrance();
		readIdentity.mockRejectedValueOnce(new Error("private upstream body"));
		const { state } = gate.start();
		await expect(
			gate.complete({ state, cookie: state, code: "code" }),
		).rejects.toThrow(
			"Company OAuth entrance failed; start a new authorization",
		);
		await expect(
			gate.complete({ state, cookie: state, code: "code" }),
		).rejects.toThrow("Taken");
	});
});
