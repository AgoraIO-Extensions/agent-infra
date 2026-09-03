import { Buffer } from "node:buffer";

import type { AgentConfigurationRecordV1 } from "./agent-configuration.js";

const maximumAttachments = 160;

export interface PendingSecretRecordExpectationV1 {
	readonly schemaVersion: 1;
	readonly ownerType: "agent-owner";
	readonly ownerId: string;
	readonly agentId: string;
	readonly name: string;
	readonly secretId: string;
	readonly secretVersion: number;
	readonly configurationRevision: number;
	readonly occurredAt: string;
}

export interface PendingSecretRecordAttachmentResolverV1 {
	resolve(input: {
		readonly schemaVersion: 1;
		readonly expected: readonly PendingSecretRecordExpectationV1[];
	}): Promise<unknown>;
}

export interface PendingSecretRecordAttachmentsV1 {
	readonly schemaVersion: 1;
	readonly expected: readonly PendingSecretRecordExpectationV1[];
	readonly encryptedRecords: unknown;
}

export class PendingSecretRecordAttachmentError extends Error {
	constructor() {
		super("Pending Secret record attachment is invalid");
		this.name = "PendingSecretRecordAttachmentError";
	}
}

interface SecretReference {
	readonly name: string;
	readonly secretId: string;
	readonly secretVersion: number;
}

function validText(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.includes("\0") &&
		String.prototype.isWellFormed.call(value) &&
		Buffer.byteLength(value, "utf8") <= 1024
	);
}

function referenceKey(reference: SecretReference): string {
	return `${reference.name}\0${reference.secretId}\0${reference.secretVersion}`;
}

function referencesForConfiguration(
	configuration: AgentConfigurationRecordV1,
): SecretReference[] {
	const references: SecretReference[] = [
		...configuration.secrets.map(({ name, secretId, version }) => ({
			name,
			secretId,
			secretVersion: version,
		})),
		...(configuration.modelConfiguration?.options.map(
			({ optionId, credential }) => ({
				name: `model:${optionId}`,
				secretId: credential.secretId,
				secretVersion: credential.version,
			}),
		) ?? []),
	];
	if (
		references.length > maximumAttachments ||
		references.some(
			({ name, secretId, secretVersion }) =>
				!validText(name) ||
				!validText(secretId) ||
				!Number.isSafeInteger(secretVersion) ||
				secretVersion < 1,
		) ||
		new Set(references.map(referenceKey)).size !== references.length ||
		new Set(
			references.map(
				({ secretId, secretVersion }) => `${secretId}\0${secretVersion}`,
			),
		).size !== references.length
	) {
		throw new PendingSecretRecordAttachmentError();
	}
	return references.toSorted((left, right) => {
		const leftKey = referenceKey(left);
		const rightKey = referenceKey(right);
		return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
	});
}

function timestamp(value: Date): string {
	try {
		const milliseconds = Date.prototype.getTime.call(value);
		if (!Number.isFinite(milliseconds)) throw new Error();
		return new Date(milliseconds).toISOString();
	} catch {
		throw new PendingSecretRecordAttachmentError();
	}
}

export async function resolvePendingSecretRecordAttachmentsV1(input: {
	readonly attachment?: PendingSecretRecordAttachmentResolverV1;
	readonly previousConfiguration?: AgentConfigurationRecordV1;
	readonly configuration: AgentConfigurationRecordV1;
	readonly ownerId: string;
	readonly occurredAt: Date;
}): Promise<PendingSecretRecordAttachmentsV1 | undefined> {
	if (input.attachment === undefined) return undefined;
	if (
		!validText(input.ownerId) ||
		!validText(input.configuration.agentId) ||
		!Number.isSafeInteger(input.configuration.revision) ||
		input.configuration.revision < 1
	) {
		throw new PendingSecretRecordAttachmentError();
	}
	const previous = new Set(
		input.previousConfiguration === undefined
			? []
			: referencesForConfiguration(input.previousConfiguration).map(
					referenceKey,
				),
	);
	const occurredAt = timestamp(input.occurredAt);
	const expected = referencesForConfiguration(input.configuration)
		.filter((reference) => !previous.has(referenceKey(reference)))
		.map((reference) =>
			Object.freeze({
				schemaVersion: 1 as const,
				ownerType: "agent-owner" as const,
				ownerId: input.ownerId,
				agentId: input.configuration.agentId,
				name: reference.name,
				secretId: reference.secretId,
				secretVersion: reference.secretVersion,
				configurationRevision: input.configuration.revision,
				occurredAt,
			}),
		);
	if (expected.length === 0) {
		throw new PendingSecretRecordAttachmentError();
	}
	const immutableExpected = Object.freeze(expected);
	let encryptedRecords: unknown;
	try {
		encryptedRecords = await input.attachment.resolve({
			schemaVersion: 1,
			expected: immutableExpected,
		});
	} catch {
		throw new PendingSecretRecordAttachmentError();
	}
	if (encryptedRecords === undefined) {
		throw new PendingSecretRecordAttachmentError();
	}
	return Object.freeze({
		schemaVersion: 1,
		expected: immutableExpected,
		encryptedRecords,
	});
}
