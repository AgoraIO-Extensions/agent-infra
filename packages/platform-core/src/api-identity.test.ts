import { describe, expect, it } from "vitest";

import {
	generateApiCredentialV1,
	hasApiCredentialScopeV1,
	hashApiCredentialV1,
	sameApiPrincipalV1,
} from "./api-identity.js";

describe("API identity primitives", () => {
	it("generates a bearer value without retaining its plaintext", () => {
		const credential = generateApiCredentialV1((size) =>
			new Uint8Array(size).fill(7),
		);
		expect(credential).toHaveLength(43);
		expect(hashApiCredentialV1(credential)).toMatch(/^[a-f0-9]{64}$/);
		expect(hashApiCredentialV1(credential)).not.toContain(credential);
	});

	it("checks scope, expiry, and revocation together", () => {
		const now = new Date("2026-01-01T00:00:00.000Z");
		const metadata = {
			scopes: ["agent:create"] as const,
			expiresAt: new Date("2026-01-01T00:00:01.000Z"),
			revokedAt: null,
		};
		expect(hasApiCredentialScopeV1(metadata, "agent:create", now)).toBe(true);
		expect(hasApiCredentialScopeV1(metadata, "agent:manage", now)).toBe(false);
		expect(
			hasApiCredentialScopeV1(
				{ ...metadata, expiresAt: new Date("2025-12-31T23:59:59.000Z") },
				"agent:create",
				now,
			),
		).toBe(false);
		expect(
			hasApiCredentialScopeV1(
				{ ...metadata, revokedAt: new Date("2025-12-31T23:59:59.000Z") },
				"agent:create",
				now,
			),
		).toBe(false);
	});

	it("binds principal kind as well as ID", () => {
		expect(
			sameApiPrincipalV1(
				{ kind: "user", id: "same" },
				{ kind: "application", id: "same" },
			),
		).toBe(false);
	});
});
