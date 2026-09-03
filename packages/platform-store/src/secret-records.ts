import { Buffer } from "node:buffer";
import { types } from "node:util";

import { validatePlatformSecretRecordV1 } from "@agent-infra/contracts/workload";
import type {
	PendingSecretRecordAttachmentsV1,
	PendingSecretRecordExpectationV1,
} from "@agent-infra/platform-core";
import type { drizzle } from "drizzle-orm/postgres-js";

import { platformSecretRecords } from "./schema.js";

type Transaction = Parameters<
	Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
>[0];

export class PendingSecretRecordStoreError extends Error {
	constructor() {
		super("Pending Secret record persistence failed");
		this.name = "PendingSecretRecordStoreError";
	}
}

function validText(input: unknown): input is string {
	return (
		typeof input === "string" &&
		input.length > 0 &&
		!input.includes("\0") &&
		String.prototype.isWellFormed.call(input) &&
		Buffer.byteLength(input, "utf8") <= 1024
	);
}

function snapshotArray(input: unknown, maximum: number): unknown[] {
	if (
		!Array.isArray(input) ||
		types.isProxy(input) ||
		Object.getPrototypeOf(input) !== Array.prototype ||
		input.length === 0 ||
		input.length > maximum ||
		Reflect.ownKeys(input).length !== input.length + 1
	) {
		throw new PendingSecretRecordStoreError();
	}
	const snapshot: unknown[] = [];
	for (let index = 0; index < input.length; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
		if (
			descriptor?.enumerable !== true ||
			!Object.hasOwn(descriptor, "value") ||
			Object.hasOwn(descriptor, "get") ||
			Object.hasOwn(descriptor, "set")
		) {
			throw new PendingSecretRecordStoreError();
		}
		snapshot.push(descriptor.value);
	}
	return snapshot;
}

function snapshotExpectation(input: unknown): PendingSecretRecordExpectationV1 {
	try {
		if (
			!input ||
			typeof input !== "object" ||
			Array.isArray(input) ||
			types.isProxy(input) ||
			Object.getPrototypeOf(input) !== Object.prototype
		) {
			throw new Error();
		}
		const value = input as Record<string, unknown>;
		const keys = [
			"schemaVersion",
			"ownerType",
			"ownerId",
			"agentId",
			"name",
			"secretId",
			"secretVersion",
			"configurationRevision",
			"occurredAt",
		];
		if (
			Object.keys(value).length !== keys.length ||
			keys.some((key) => !Object.hasOwn(value, key)) ||
			value.schemaVersion !== 1 ||
			value.ownerType !== "agent-owner" ||
			[value.ownerId, value.agentId, value.name, value.secretId].some(
				(entry) => !validText(entry),
			) ||
			!validText(value.occurredAt) ||
			![value.secretVersion, value.configurationRevision].every(
				(entry) => Number.isSafeInteger(entry) && (entry as number) >= 1,
			) ||
			new Date(value.occurredAt as string).toISOString() !== value.occurredAt
		) {
			throw new Error();
		}
		return {
			schemaVersion: 1,
			ownerType: "agent-owner",
			ownerId: value.ownerId as string,
			agentId: value.agentId as string,
			name: value.name as string,
			secretId: value.secretId as string,
			secretVersion: value.secretVersion as number,
			configurationRevision: value.configurationRevision as number,
			occurredAt: value.occurredAt as string,
		};
	} catch {
		throw new PendingSecretRecordStoreError();
	}
}

function expectationKey(input: PendingSecretRecordExpectationV1): string {
	return `${input.agentId}\0${input.secretId}\0${input.secretVersion}\0${input.configurationRevision}`;
}

export async function insertPendingSecretRecordAttachments(
	transaction: Transaction,
	attachments: PendingSecretRecordAttachmentsV1 | undefined,
): Promise<void> {
	if (attachments === undefined) return;
	try {
		if (attachments.schemaVersion !== 1) throw new Error();
		const expected = snapshotArray(attachments.expected, 160).map(
			snapshotExpectation,
		);
		const expectedByKey = new Map(
			expected.map((expectation) => [expectationKey(expectation), expectation]),
		);
		if (expectedByKey.size !== expected.length) throw new Error();
		const records = snapshotArray(
			attachments.encryptedRecords,
			expected.length,
		).map((record) => validatePlatformSecretRecordV1(record));
		const rows = records.map((record) => {
			if (record.lifecycleState !== "pending") throw new Error();
			const expectation = expectedByKey.get(
				`${record.agentId}\0${record.secretId}\0${record.secretVersion}\0${record.configRevision}`,
			);
			if (
				!expectation ||
				record.ownerType !== expectation.ownerType ||
				record.ownerId !== expectation.ownerId ||
				record.name !== expectation.name ||
				record.createdAt !== expectation.occurredAt ||
				record.updatedAt !== expectation.occurredAt
			) {
				throw new Error();
			}
			expectedByKey.delete(expectationKey(expectation));
			return {
				agentId: record.agentId,
				secretId: record.secretId,
				secretVersion: record.secretVersion,
				configurationRevision: record.configRevision,
				ownerType: record.ownerType,
				ownerId: record.ownerId,
				name: record.name,
				lifecycleState: record.lifecycleState,
				dekFingerprint: record.crypto.dekFingerprint,
				record,
				createdAt: new Date(record.createdAt),
				updatedAt: new Date(record.updatedAt),
			};
		});
		if (expectedByKey.size !== 0) throw new Error();
		await transaction.insert(platformSecretRecords).values(rows);
	} catch (error) {
		if (error instanceof PendingSecretRecordStoreError) throw error;
		throw new PendingSecretRecordStoreError();
	}
}
