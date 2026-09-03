import { Buffer } from "node:buffer";
import { types } from "node:util";

import { validatePlatformSecretRecordV1 } from "@agent-infra/contracts/workload";
import type {
	AgentConfigurationRecordV1,
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

function configurationReferenceKey(input: {
	readonly name: string;
	readonly secretId: string;
	readonly secretVersion: number;
}): string {
	return `${input.name}\0${input.secretId}\0${input.secretVersion}`;
}

function configurationReferenceKeys(
	configuration: AgentConfigurationRecordV1,
): ReadonlySet<string> {
	const references = [
		...configuration.secrets.map(({ name, secretId, version, isSet }) => ({
			name,
			secretId,
			secretVersion: version,
			isSet,
		})),
		...(configuration.modelConfiguration?.options.map(
			({ optionId, credential }) => ({
				name: `model:${optionId}`,
				secretId: credential.secretId,
				secretVersion: credential.version,
				isSet: credential.isSet,
			}),
		) ?? []),
	];
	if (
		references.length > 160 ||
		references.some(
			({ name, secretId, secretVersion, isSet }) =>
				!validText(name) ||
				!validText(secretId) ||
				!Number.isSafeInteger(secretVersion) ||
				secretVersion < 1 ||
				isSet !== true,
		) ||
		new Set(references.map(configurationReferenceKey)).size !==
			references.length
	) {
		throw new PendingSecretRecordStoreError();
	}
	return new Set(references.map(configurationReferenceKey));
}

export async function insertPendingSecretRecordAttachments(
	transaction: Transaction,
	attachments: PendingSecretRecordAttachmentsV1 | undefined,
	configuration: AgentConfigurationRecordV1,
	previousConfiguration?: AgentConfigurationRecordV1,
): Promise<void> {
	try {
		const configurationReferences = configurationReferenceKeys(configuration);
		const previousReferences =
			previousConfiguration === undefined
				? new Set<string>()
				: configurationReferenceKeys(previousConfiguration);
		const introducedReferences = new Set(
			[...configurationReferences].filter(
				(reference) => !previousReferences.has(reference),
			),
		);
		if (attachments === undefined) {
			if (introducedReferences.size !== 0) throw new Error();
			return;
		}
		if (attachments.schemaVersion !== 1) throw new Error();
		const expected = snapshotArray(attachments.expected, 160).map(
			snapshotExpectation,
		);
		const expectedByKey = new Map(
			expected.map((expectation) => [expectationKey(expectation), expectation]),
		);
		if (expectedByKey.size !== expected.length) throw new Error();
		const expectedReferences = new Set(expected.map(configurationReferenceKey));
		if (
			expectedReferences.size !== expected.length ||
			expectedReferences.size !== introducedReferences.size ||
			[...expectedReferences].some(
				(reference) => !introducedReferences.has(reference),
			) ||
			expected.some(
				(expectation) =>
					expectation.agentId !== configuration.agentId ||
					expectation.configurationRevision !== configuration.revision ||
					!configurationReferences.has(configurationReferenceKey(expectation)),
			)
		) {
			throw new Error();
		}
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
