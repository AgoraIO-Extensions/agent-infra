import { types } from "node:util";

import type { PendingSecretRecordAttachmentResolverV1 } from "@agent-infra/platform-core";
import type { SecretEncryptorV1 } from "@agent-infra/secret-store";

export interface PreparedSecretPlaintextV1 {
	readonly secretId: string;
	readonly version: number;
	readonly plaintext: string;
}

function key(secretId: string, version: number): string {
	return `${secretId}\0${version}`;
}

export function parsePendingSecretRecordAttachmentResolverV1(
	input: unknown,
): PendingSecretRecordAttachmentResolverV1 {
	if (
		!input ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		types.isProxy(input) ||
		Object.getPrototypeOf(input) !== Object.prototype ||
		Reflect.ownKeys(input).length !== 1
	) {
		throw new TypeError("Prepared Secret attachment is invalid");
	}
	const resolve = Object.getOwnPropertyDescriptor(input, "resolve");
	if (
		resolve?.enumerable !== true ||
		!Object.hasOwn(resolve, "value") ||
		Object.hasOwn(resolve, "get") ||
		Object.hasOwn(resolve, "set") ||
		typeof resolve.value !== "function"
	) {
		throw new TypeError("Prepared Secret attachment is invalid");
	}
	return input as PendingSecretRecordAttachmentResolverV1;
}

export function createPendingSecretRecordAttachmentResolverV1(input: {
	readonly encryptor: SecretEncryptorV1;
	readonly plaintexts: readonly PreparedSecretPlaintextV1[];
}): PendingSecretRecordAttachmentResolverV1 {
	const plaintexts = new Map(
		input.plaintexts.map((plaintext) => [
			key(plaintext.secretId, plaintext.version),
			plaintext.plaintext,
		]),
	);
	if (plaintexts.size !== input.plaintexts.length) {
		throw new TypeError("Prepared Secret plaintexts are invalid");
	}
	let consumed = false;
	return {
		async resolve({ expected }) {
			if (consumed) throw new TypeError("Prepared Secret attachment is spent");
			consumed = true;
			try {
				const expectedKeys = new Set(
					expected.map(({ secretId, secretVersion }) =>
						key(secretId, secretVersion),
					),
				);
				if (
					expectedKeys.size !== expected.length ||
					expectedKeys.size !== plaintexts.size
				) {
					throw new TypeError("Prepared Secret metadata is invalid");
				}
				return expected.map((expectation) => {
					const plaintext = plaintexts.get(
						key(expectation.secretId, expectation.secretVersion),
					);
					if (plaintext === undefined) {
						throw new TypeError("Prepared Secret plaintext is unavailable");
					}
					return input.encryptor.encrypt({
						schemaVersion: 1,
						secretId: expectation.secretId,
						ownerType: expectation.ownerType,
						ownerId: expectation.ownerId,
						agentId: expectation.agentId,
						name: expectation.name,
						secretVersion: expectation.secretVersion,
						configRevision: expectation.configurationRevision,
						plaintext,
						occurredAt: expectation.occurredAt,
					});
				});
			} finally {
				plaintexts.clear();
			}
		},
	};
}
