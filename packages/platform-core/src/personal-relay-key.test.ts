import { describe, expect, it, vi } from "vitest";

import {
	createPersonalRelayKeyUseCaseV1,
	PersonalRelayKeyErrorV1,
	type PersonalRelayKeyStorePortV1,
	personalRelayKeyAuditIntentV1,
} from "./personal-relay-key.js";

const userId = "b3590249-c256-4c81-82f7-baf1ec9c34da";
const actor = { userId, accountStatus: "active" as const };
const keyValue = "relay-test-key-value";

function fixture() {
	const store = {
		current: vi.fn(async () => null as number | null),
		replace: vi.fn(async () => 1 as number | null),
		revoke: vi.fn(async () => true),
		recordRejected: vi.fn(async () => {}),
	} satisfies PersonalRelayKeyStorePortV1;
	const validate = vi.fn(
		async () => "valid" as "valid" | "invalid" | "unavailable",
	);
	return {
		store,
		validate,
		keys: createPersonalRelayKeyUseCaseV1({ store, validate }),
	};
}

describe("personal Relay Key Core", () => {
	it("chooses read, write, stale, and early-rejection audit outcomes", () => {
		expect(personalRelayKeyAuditIntentV1({ operation: "current" })).toEqual({
			action: "relay_key.personal.read",
			outcome: "succeeded",
		});
		expect(
			personalRelayKeyAuditIntentV1({
				operation: "replace",
				result: "replaced",
			}),
		).toEqual({ action: "relay_key.personal.replaced", outcome: "succeeded" });
		expect(
			personalRelayKeyAuditIntentV1({
				operation: "revoke",
				result: "revoked",
			}),
		).toEqual({ action: "relay_key.personal.revoked", outcome: "succeeded" });
		for (const operation of ["replace", "revoke"] as const)
			expect(
				personalRelayKeyAuditIntentV1({ operation, result: "stale" }),
			).toEqual({
				action: "relay_key.personal.rejected",
				outcome: "rejected",
				reason: "STALE_VERSION",
			});
		expect(
			personalRelayKeyAuditIntentV1({
				operation: "rejected",
				outcome: "failed",
				reason: "VALIDATION_UNAVAILABLE",
			}),
		).toEqual({
			action: "relay_key.personal.rejected",
			outcome: "failed",
			reason: "VALIDATION_UNAVAILABLE",
		});
	});

	it("returns only the current version and derives the subject from the trusted actor", async () => {
		const { keys, store } = fixture();
		expect(await keys.current(actor, "trace", "request")).toEqual({
			schemaVersion: 1,
			isSet: false,
			keyVersion: null,
		});
		expect(store.current).toHaveBeenCalledWith({
			actorUserId: userId,
			traceId: "trace",
			requestId: "request",
		});
		store.current.mockResolvedValueOnce(3);
		expect(await keys.current(actor, "trace", "request")).toEqual({
			schemaVersion: 1,
			isSet: true,
			keyVersion: 3,
		});
	});

	it("rejects disabled and API credential actors before touching the Store", async () => {
		const { keys, store, validate } = fixture();
		await expect(
			keys.replace(
				{ ...actor, accountStatus: "disabled" },
				{ expectedVersion: null, keyValue },
				"trace",
				"request",
			),
		).rejects.toEqual(new PersonalRelayKeyErrorV1("not_authorized"));
		await expect(
			keys.current(
				{ ...actor, principal: { kind: "user", id: userId } },
				"trace",
				"request",
			),
		).rejects.toEqual(new PersonalRelayKeyErrorV1("not_authorized"));
		expect(validate).not.toHaveBeenCalled();
		expect(store.current).not.toHaveBeenCalled();
		expect(store.replace).not.toHaveBeenCalled();
	});

	it("validates before storing and never returns the Key value", async () => {
		const { keys, store, validate } = fixture();
		validate.mockResolvedValueOnce("invalid");
		await expect(
			keys.replace(
				actor,
				{ expectedVersion: null, keyValue },
				"trace",
				"request",
			),
		).rejects.toEqual(new PersonalRelayKeyErrorV1("invalid_key"));
		validate.mockResolvedValueOnce("unavailable");
		await expect(
			keys.replace(
				actor,
				{ expectedVersion: null, keyValue },
				"trace",
				"request",
			),
		).rejects.toEqual(new PersonalRelayKeyErrorV1("dependency_unavailable"));
		expect(store.replace).not.toHaveBeenCalled();
		const state = await keys.replace(
			actor,
			{ expectedVersion: null, keyValue },
			"trace",
			"request",
		);
		expect(state).toEqual({ schemaVersion: 1, isSet: true, keyVersion: 1 });
		expect(JSON.stringify(state)).not.toContain(keyValue);
		expect(store.replace).toHaveBeenCalledWith({
			actorUserId: userId,
			expectedVersion: null,
			keyValue,
			traceId: "trace",
			requestId: "request",
		});
	});

	it("reports stale replace and revoke without exposing another version", async () => {
		const { keys, store } = fixture();
		store.replace.mockResolvedValueOnce(null);
		await expect(
			keys.replace(actor, { expectedVersion: 2, keyValue }, "trace", "request"),
		).rejects.toEqual(new PersonalRelayKeyErrorV1("conflict"));
		store.revoke.mockResolvedValueOnce(false);
		await expect(keys.revoke(actor, 2, "trace", "request")).rejects.toEqual(
			new PersonalRelayKeyErrorV1("conflict"),
		);
		expect(await keys.revoke(actor, 1, "trace", "request")).toEqual({
			schemaVersion: 1,
			isSet: false,
			keyVersion: null,
		});
	});
});
