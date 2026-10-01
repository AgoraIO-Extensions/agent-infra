import { describe, expect, it, vi } from "vitest";
import {
	createPersonalRelayKeyUseCaseV1,
	type PersonalRelayKeyIdentityV1,
	type PersonalRelayKeyTransactionV1,
} from "./personal-relay-key.js";

const request = {
	userId: "user_alice",
	requestId: "request_1",
	traceId: "trace_1",
};
const identity = {
	userId: request.userId,
	accountStatus: "active",
	authorizationRevision: "r1",
} as const;
const key = "SYNTHETIC_PERSONAL_KEY_SENTINEL";
const binding = {
	purpose: "personal",
	subjectId: request.userId,
	keyId: "key1",
	keyVersion: 1,
} as const;

function setup() {
	const transaction = {
		lockUserDisabled: vi.fn(async () => false),
		current: vi.fn(async (): Promise<number | null> => null),
		replace: vi.fn<PersonalRelayKeyTransactionV1["replace"]>(
			async (_userId, _version, encrypt) => {
				await encrypt(binding);
				return 1;
			},
		),
		revoke: vi.fn(async () => true),
		recordAudit: vi.fn(async () => {}),
	} satisfies PersonalRelayKeyTransactionV1;
	const port = {
		execute: async <T>(
			work: (transaction: PersonalRelayKeyTransactionV1) => Promise<T>,
		) => work(transaction),
		recordAudit: vi.fn(async () => {}),
	};
	const currentIdentity = vi.fn(
		async (): Promise<PersonalRelayKeyIdentityV1 | null> => identity,
	);
	const validate = vi.fn(
		async (): Promise<"valid" | "invalid" | "unavailable"> => "valid",
	);
	const encrypt = vi.fn(async () => ({ encrypted: true }));
	const keys = createPersonalRelayKeyUseCaseV1({
		transaction: port,
		currentIdentity,
		validate,
		encrypt,
	});
	return { transaction, port, currentIdentity, validate, encrypt, keys };
}

describe("personal Relay Key governance", () => {
	it("rejects unknown own __proto__ fields in commands and trusted request data", async () => {
		const { keys, transaction, port, validate } = setup();
		const extra = <T extends object>(value: T) =>
			Object.defineProperty(value, "__proto__", {
				enumerable: true,
				value: {},
			});
		expect(() =>
			keys.replace(request, extra({ expectedVersion: null, keyValue: key })),
		).toThrow("Personal Relay Key operation failed");
		expect(() => keys.revoke(request, extra({ expectedVersion: 1 }))).toThrow(
			"Personal Relay Key operation failed",
		);
		await expect(keys.current(extra({ ...request }))).rejects.toMatchObject({
			code: "invalid_input",
		});
		expect(validate).not.toHaveBeenCalled();
		expect(transaction.current).not.toHaveBeenCalled();
		expect(transaction.recordAudit).not.toHaveBeenCalled();
		expect(port.recordAudit).not.toHaveBeenCalled();
	});
	it.each(["!".repeat(16), "~".repeat(8192), "AZaz09!~_-+/=.\\xx"])(
		"accepts printable ASCII Key boundaries",
		async (keyValue) => {
			const { keys, validate } = setup();
			await expect(
				keys.replace(request, { expectedVersion: null, keyValue }),
			).resolves.toMatchObject({ isSet: true });
			expect(validate).toHaveBeenCalledWith(keyValue);
		},
	);
	it("captures request/command before async validation and encrypts the actual binding", async () => {
		const { keys, encrypt, currentIdentity, transaction } = setup();
		const submitted = { ...request };
		const command = { expectedVersion: null, keyValue: key };
		const result = keys.replace(submitted, command);
		submitted.userId = "user_other";
		command.keyValue = "OTHER_SYNTHETIC_KEY_SENTINEL";
		await expect(result).resolves.toEqual({
			schemaVersion: 1,
			isSet: true,
			keyVersion: 1,
		});
		expect(encrypt).toHaveBeenCalledWith(binding, key);
		expect(currentIdentity).toHaveBeenCalledTimes(2);
		expect(transaction.lockUserDisabled).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(transaction.recordAudit.mock.calls)).not.toContain(
			key,
		);
	});

	it.each(["disabled", "other", "missing", "error"])(
		"refuses entry %s before validating or encrypting",
		async (mode) => {
			const { keys, currentIdentity, validate, encrypt } = setup();
			currentIdentity.mockImplementation(async () => {
				if (mode === "error") throw new Error(key);
				if (mode === "missing") return null;
				return {
					...identity,
					userId: mode === "other" ? "user_bob" : identity.userId,
					accountStatus: mode === "disabled" ? "disabled" : "active",
				};
			});
			await expect(
				keys.replace(request, { expectedVersion: null, keyValue: key }),
			).rejects.toThrow("Personal Relay Key operation failed");
			expect(validate).not.toHaveBeenCalled();
			expect(encrypt).not.toHaveBeenCalled();
		},
	);

	it.each(["disabled", "other", "missing", "revision", "error"])(
		"fails final identity %s after writes, with a sanitized refusal",
		async (mode) => {
			const { keys, currentIdentity, transaction, port } = setup();
			currentIdentity
				.mockImplementationOnce(async () => identity)
				.mockImplementationOnce(async () => {
					if (mode === "error") throw new Error(key);
					if (mode === "missing") return null;
					return {
						...identity,
						userId: mode === "other" ? "user_bob" : identity.userId,
						accountStatus: mode === "disabled" ? "disabled" : "active",
						authorizationRevision: mode === "revision" ? "r2" : "r1",
					};
				});
			await expect(
				keys.replace(request, { expectedVersion: null, keyValue: key }),
			).rejects.toThrow("Personal Relay Key operation failed");
			expect(transaction.replace).toHaveBeenCalledTimes(1);
			expect(port.recordAudit).toHaveBeenCalledTimes(1);
			expect(JSON.stringify(port.recordAudit.mock.calls)).not.toContain(key);
		},
	);

	it("refuses Platform disable even when browser identity still says active", async () => {
		const { keys, transaction, currentIdentity } = setup();
		transaction.lockUserDisabled.mockResolvedValue(true);
		await expect(keys.current(request)).rejects.toMatchObject({
			code: "not_authorized",
		});
		expect(currentIdentity).not.toHaveBeenCalled();
		expect(transaction.current).not.toHaveBeenCalled();
	});

	it.each(["invalid", "unavailable"] as const)(
		"does not mutate after validator %s",
		async (validity) => {
			const { keys, validate, transaction } = setup();
			validate.mockResolvedValue(validity);
			await expect(
				keys.replace(request, { expectedVersion: null, keyValue: key }),
			).rejects.toMatchObject({
				code: validity === "invalid" ? "invalid_input" : "unavailable",
			});
			expect(transaction.replace).not.toHaveBeenCalled();
		},
	);

	it("returns only state and records a stale CAS refusal in its original transaction", async () => {
		const { keys, transaction, port } = setup();
		transaction.replace.mockResolvedValue(null);
		await expect(
			keys.replace(request, { expectedVersion: null, keyValue: key }),
		).rejects.toMatchObject({ code: "conflict" });
		expect(transaction.recordAudit).toHaveBeenCalledWith({
			...request,
			operation: "replace",
			outcome: "rejected",
			reason: "conflict",
		});
		expect(port.recordAudit).not.toHaveBeenCalled();
		await expect(keys.revoke(request, { expectedVersion: 1 })).resolves.toEqual(
			{ schemaVersion: 1, isSet: false, keyVersion: null },
		);
	});

	it("does not deliver state after failed commit or failed mandatory audit", async () => {
		const { keys, port, transaction } = setup();
		port.execute = async (work) => {
			await work(transaction);
			throw new Error(key);
		};
		await expect(keys.current(request)).rejects.toMatchObject({
			code: "unavailable",
		});
		port.recordAudit.mockRejectedValue(new Error(key));
		await expect(keys.revoke(request, { expectedVersion: 1 })).rejects.toThrow(
			"Personal Relay Key operation failed",
		);
	});

	it.each([
		{ expectedVersion: 0, keyValue: key },
		{ expectedVersion: Number.MAX_SAFE_INTEGER + 1, keyValue: key },
		{ expectedVersion: null, keyValue: "short" },
		{ expectedVersion: null, keyValue: "a".repeat(8193) },
		{ expectedVersion: null, keyValue: key.concat(" ") },
		{ expectedVersion: null, keyValue: key.concat("\x7f") },
		{ expectedVersion: null, keyValue: key.concat("é") },
		{ expectedVersion: null, keyValue: `${key}\n` },
		{ expectedVersion: null, keyValue: key, userId: "user_bob" },
		Object.defineProperty({ expectedVersion: null }, "keyValue", {
			enumerable: true,
			get: () => {
				throw new Error("accessor was evaluated");
			},
		}),
	])(
		"rejects malformed and identity-bearing commands without reading an accessor",
		(command) => {
			const { keys, validate } = setup();
			expect(() => keys.replace(request, command)).toThrow(
				"Personal Relay Key operation failed",
			);
			expect(validate).not.toHaveBeenCalled();
		},
	);
});
