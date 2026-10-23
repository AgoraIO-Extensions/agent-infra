import { FakeObjectStorageV1 } from "@agent-infra/object-storage";
import { expect, it } from "vitest";
import { createWecomInboundMediaResolverV1 } from "./wecom-media.js";

const base = {
	databaseUrl: "postgres://fixture/fixture",
	storage: new FakeObjectStorageV1(),
	authorization: { authorize: async () => ({ outcome: "denied" as const }) },
	files: {
		transaction: async () => {
			throw new Error("unused");
		},
	},
	readLimits: async () => null,
	readAttachmentCapability: async () => null,
};

it.each([
	["an empty host list", { allowedDownloadHosts: [] }],
	[
		"a URL instead of a host",
		{ allowedDownloadHosts: ["https://example.test"] },
	],
	["a single-label host", { allowedDownloadHosts: ["intranet"] }],
	["storage without inspect", { storage: { upload: async () => ({}) } }],
	["an unbounded download timeout", { downloadTimeoutMs: 600_000 }],
	["no download concurrency", { maxConcurrentDownloads: 0 }],
	// #3258：没有 Agent 附件能力读取时不装配 resolver。
	["no attachment capability reader", { readAttachmentCapability: undefined }],
])("rejects %s before opening any store (#3227)", (_name, overrides) => {
	expect(() =>
		createWecomInboundMediaResolverV1({ ...base, ...overrides } as never),
	).toThrow("WeCom inbound media configuration is invalid");
});

it("accepts approved download hosts and closes without opening pools", async () => {
	const resolver = createWecomInboundMediaResolverV1({
		...base,
		allowedDownloadHosts: ["example.test", ".cdn.example.test"],
	});
	await expect(resolver.close()).resolves.toBeUndefined();
});
