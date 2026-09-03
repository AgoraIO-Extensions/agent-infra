import { describe, expect, it, vi } from "vitest";

import type { AgentConfigurationRecordV1 } from "./agent-configuration.js";
import {
	PendingSecretRecordAttachmentError,
	resolvePendingSecretRecordAttachmentsV1,
} from "./secret-record-attachments.js";

function configuration(
	revision: number,
	secretVersion: number,
): AgentConfigurationRecordV1 {
	return {
		schemaVersion: 1,
		agentId: "agent_01",
		revision,
		source: {
			kind: "standard",
			templateId: "template_01",
			imageDigest: `sha256:${"a".repeat(64)}`,
			admissionRevision: "admission_01",
			allowedEnvironmentKeys: [],
			allowedSecretKeys: ["BOT_TOKEN"],
			platformManagedKeys: [],
			connectionEnabled: false,
		},
		modelConfiguration: null,
		actions: [],
		actionSetRevision: "actions_01",
		environment: [],
		secrets: [
			{
				name: "BOT_TOKEN",
				secretId: "secret_bot_token",
				version: secretVersion,
				isSet: true,
			},
		],
		channels: [],
		channelRevision: "channels_01",
	};
}

describe("pending Secret record attachments", () => {
	it("resolves only the final admitted Secret metadata", async () => {
		const resolve = vi.fn().mockResolvedValue([{ opaque: "ciphertext" }]);
		const attachments = await resolvePendingSecretRecordAttachmentsV1({
			attachment: { resolve },
			previousConfiguration: configuration(1, 1),
			configuration: configuration(2, 2),
			ownerId: "owner_01",
			occurredAt: new Date("2026-09-03T12:00:00.000Z"),
		});

		expect(resolve).toHaveBeenCalledWith({
			schemaVersion: 1,
			expected: [
				{
					schemaVersion: 1,
					ownerType: "agent-owner",
					ownerId: "owner_01",
					agentId: "agent_01",
					name: "BOT_TOKEN",
					secretId: "secret_bot_token",
					secretVersion: 2,
					configurationRevision: 2,
					occurredAt: "2026-09-03T12:00:00.000Z",
				},
			],
		});
		expect(attachments?.encryptedRecords).toEqual([{ opaque: "ciphertext" }]);
	});

	it("requires an attachment for a final Secret replacement", async () => {
		await expect(
			resolvePendingSecretRecordAttachmentsV1({
				previousConfiguration: configuration(1, 1),
				configuration: configuration(2, 2),
				ownerId: "owner_01",
				occurredAt: new Date("2026-09-03T12:00:00.000Z"),
			}),
		).rejects.toBeInstanceOf(PendingSecretRecordAttachmentError);
	});

	it("allows an omitted attachment when the final configuration is Secret-free", async () => {
		await expect(
			resolvePendingSecretRecordAttachmentsV1({
				previousConfiguration: configuration(1, 1),
				configuration: {
					...configuration(2, 1),
					secrets: [],
				},
				ownerId: "owner_01",
				occurredAt: new Date("2026-09-03T12:00:00.000Z"),
			}),
		).resolves.toBeUndefined();
	});

	it("fails closed for unset Secret metadata", async () => {
		const resolve = vi.fn();
		await expect(
			resolvePendingSecretRecordAttachmentsV1({
				attachment: { resolve },
				previousConfiguration: configuration(1, 1),
				configuration: {
					...configuration(2, 2),
					secrets: [
						{
							name: "BOT_TOKEN",
							secretId: "secret_bot_token",
							version: 2,
							isSet: false,
						},
					],
				} as never,
				ownerId: "owner_01",
				occurredAt: new Date("2026-09-03T12:00:00.000Z"),
			}),
		).rejects.toBeInstanceOf(PendingSecretRecordAttachmentError);
		expect(resolve).not.toHaveBeenCalled();
	});

	it("fails closed for a malformed optional attachment", async () => {
		await expect(
			resolvePendingSecretRecordAttachmentsV1({
				attachment: null as never,
				previousConfiguration: configuration(1, 1),
				configuration: configuration(2, 2),
				ownerId: "owner_01",
				occurredAt: new Date("2026-09-03T12:00:00.000Z"),
			}),
		).rejects.toBeInstanceOf(PendingSecretRecordAttachmentError);
	});

	it("rejects an attachment that has no final Secret replacement", async () => {
		const resolve = vi.fn();
		await expect(
			resolvePendingSecretRecordAttachmentsV1({
				attachment: { resolve },
				previousConfiguration: configuration(1, 1),
				configuration: configuration(2, 1),
				ownerId: "owner_01",
				occurredAt: new Date("2026-09-03T12:00:00.000Z"),
			}),
		).rejects.toBeInstanceOf(PendingSecretRecordAttachmentError);
		expect(resolve).not.toHaveBeenCalled();
	});

	it("rejects one Secret version aliased through multiple configuration slots", async () => {
		const next = configuration(2, 2);
		const resolver = vi.fn();
		await expect(
			resolvePendingSecretRecordAttachmentsV1({
				attachment: { resolve: resolver },
				previousConfiguration: configuration(1, 1),
				configuration: {
					...next,
					modelConfiguration: {
						catalogRevision: "catalog_01",
						options: [
							{
								optionId: "model_primary",
								endpointId: "endpoint_01",
								modelId: "gpt-5",
								reasoningLevels: ["low"],
								credential: {
									secretId: "secret_bot_token",
									version: 2,
									isSet: true,
								},
							},
						],
						defaultOptionId: "model_primary",
						defaultReasoningLevel: "low",
					},
				},
				ownerId: "owner_01",
				occurredAt: new Date("2026-09-03T12:00:00.000Z"),
			}),
		).rejects.toBeInstanceOf(PendingSecretRecordAttachmentError);
		expect(resolver).not.toHaveBeenCalled();
	});
});
