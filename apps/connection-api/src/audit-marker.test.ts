import { expect, it } from "vitest";
import { redactedLoginMarker } from "./audit-marker";

it("uses stable, domain-separated markers without exposing account or source", () => {
	const key = Buffer.alloc(32, 7);
	const account = redactedLoginMarker(key, "pilot", "account", "alice");
	expect(account).toMatch(/^[a-f0-9]{64}$/);
	expect(account).toBe(redactedLoginMarker(key, "pilot", "account", "alice"));
	expect(account).not.toContain("alice");
	expect(account).not.toBe(
		redactedLoginMarker(key, "pilot", "source", "alice"),
	);
	expect(account).not.toBe(
		redactedLoginMarker(key, "other", "account", "alice"),
	);
});
