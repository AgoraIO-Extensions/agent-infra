import { generateKeyPairSync } from "node:crypto";
import { FakeObjectStorageV1 } from "@agent-infra/object-storage";
import type {
	FileLimitDeclarationRecordV1,
	FileLimitDeclarationStoreV1,
	FileLimitDeclarationSubjectV1,
} from "@agent-infra/platform-core";
import { expect, it, vi } from "vitest";
import { assemblePlatformFilesV1 } from "./file-assembly.js";

const record = (
	revision: number,
	overrides: Partial<FileLimitDeclarationRecordV1> = {},
): FileLimitDeclarationRecordV1 => ({
	scope: "agent",
	agentId: "agent",
	channelId: null,
	revision,
	expiresAt: "2099-01-01T00:00:00.000Z",
	mediaTypes: ["text/plain"],
	maxBytes: 1024,
	updatedAt: "2026-10-21T00:00:00.000Z",
	updatedBy: "owner",
	...overrides,
});

function declarationStore(
	records: {
		deployment?: FileLimitDeclarationRecordV1;
		agent?: FileLimitDeclarationRecordV1;
		channel?: FileLimitDeclarationRecordV1;
	},
	configurationRevision = 7,
) {
	const read = vi.fn(async (subject: FileLimitDeclarationSubjectV1) =>
		subject.scope === "deployment"
			? (records.deployment ?? null)
			: subject.scope === "agent"
				? (records.agent ?? null)
				: (records.channel ?? null),
	);
	const store = {
		read,
		write: vi.fn(async () => record(1)),
		readAgentConfigurationRevision: vi.fn(async () => configurationRevision),
	} satisfies FileLimitDeclarationStoreV1;
	return store;
}

function assembly(
	readLimits: Parameters<
		typeof assemblePlatformFilesV1
	>[0]["deployment"]["readLimits"],
	limitDeclarations?: FileLimitDeclarationStoreV1,
) {
	const keys = generateKeyPairSync("ed25519");
	return assemblePlatformFilesV1({
		databaseUrl: "postgres://unused:unused@127.0.0.1:1/unused",
		identity: { resolve: async () => null, hydrateUsers: async () => [] },
		limitDeclarations,
		readCurrentLimits: async () => null,
		conversationAuthorization: {
			authorize: async () => ({ outcome: "unavailable" }),
		},
		deployment: {
			storage: new FakeObjectStorageV1(),
			issuer: "platform-files",
			keyVersion: "file-key",
			...keys,
			publicKeys: new Map([["file-key", keys.publicKey]]),
			runtimeIssuer: "platform-runtime",
			runtimePublicKeys: new Map([["runtime-key", keys.publicKey]]),
			intentTtlMs: 60000,
			accessTtlMs: 10000,
			maxConcurrentTransfers: 2,
			services: [
				{
					token: "synthetic-service-token-442-123456789",
					agentIds: ["agent"],
				},
			],
			resolveActor: async () => null,
			...(readLimits ? { readLimits } : {}),
		},
	});
}

it("defaults readLimits to the authoritative declaration store", async () => {
	const store = declarationStore({
		deployment: record(3, {
			scope: "deployment",
			agentId: "",
			maxBytes: 4096,
		}),
		agent: record(4, { maxBytes: 2048 }),
		channel: record(5, {
			scope: "channel",
			channelId: "web",
			maxBytes: 8192,
		}),
	});
	const assembled = assembly(undefined, store);
	try {
		await expect(
			assembled.readLimits({
				agentId: "agent",
				channelId: "web",
				configurationRevision: 7,
				kind: "attachment",
			}),
		).resolves.toEqual({
			configurationRevision: 7,
			declarations: {
				deployment: {
					revision: "3",
					expiresAt: "2099-01-01T00:00:00.000Z",
					mediaTypes: ["text/plain"],
					maxBytes: 4096,
				},
				agent: {
					revision: "4",
					expiresAt: "2099-01-01T00:00:00.000Z",
					mediaTypes: ["text/plain"],
					maxBytes: 2048,
				},
				channel: {
					revision: "5",
					expiresAt: "2099-01-01T00:00:00.000Z",
					mediaTypes: ["text/plain"],
					maxBytes: 8192,
				},
			},
		});
		expect(store.read).toHaveBeenCalledTimes(3);
		expect(store.readAgentConfigurationRevision).toHaveBeenCalledWith("agent");
	} finally {
		await assembled.close();
	}
});

it("keeps the deployment readLimits override ahead of the store", async () => {
	const store = declarationStore({});
	const override = vi.fn(async () => ({
		configurationRevision: 9,
		declarations: { deployment: null, agent: null, channel: null },
	}));
	const assembled = assembly(override, store);
	try {
		await expect(
			assembled.readLimits({
				agentId: "agent",
				channelId: "web",
				configurationRevision: 7,
				kind: "result",
			}),
		).resolves.toMatchObject({ configurationRevision: 9 });
		expect(override).toHaveBeenCalledWith({
			agentId: "agent",
			channelId: "web",
			configurationRevision: 7,
			kind: "result",
		});
		expect(store.read).not.toHaveBeenCalled();
	} finally {
		await assembled.close();
	}
});
