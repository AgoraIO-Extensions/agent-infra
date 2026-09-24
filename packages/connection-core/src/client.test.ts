import { expect, it } from "vitest";
import {
	ClientAuthorizationDenied,
	recheckDirectClientPrincipal,
} from "./client.js";

it("disables a missing LDAP Principal before Direct credentials can be used", async () => {
	let disabled = 0;
	const principals = {
		findById: async () => ({
			id: "alice",
			issuer: "ldap",
			uid: "alice",
			status: "active" as const,
			recoveryGeneration: 1,
		}),
		disable: async () => {
			disabled++;
		},
	};
	await expect(
		recheckDirectClientPrincipal("alice", "ldap", principals, {
			entryExists: async () => false,
		}),
	).rejects.toBeInstanceOf(ClientAuthorizationDenied);
	expect(disabled).toBe(1);
	await expect(
		recheckDirectClientPrincipal("alice", "ldap", principals, {
			entryExists: async () => {
				throw new Error("LDAP unavailable");
			},
		}),
	).rejects.toThrow("LDAP unavailable");
	expect(disabled).toBe(1);
});
