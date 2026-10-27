import { describe, expect, it } from "vitest";
import { createSkillPackageConsumerV1 } from "./skill-package-consumer.js";

describe("publication consumer", () => {
	it("fails closed without a committed original publication before reading storage", async () => {
		let reads = 0;
		const consumer = createSkillPackageConsumerV1({
			readPublication: async () => null,
			storage: {
				download: async () => {
					reads++;
					throw new Error("must not read");
				},
			},
			resolveAdmissionPolicy: async () => {
				throw new Error("must not read");
			},
			sourceVerifier: {
				verify: async () => {
					throw new Error("must not read");
				},
			},
		});
		await expect(
			consumer.verify({
				skillVersionId: "v1",
				packageObjectVersion: "object-v1",
			}),
		).rejects.toMatchObject({ code: "dependency_unavailable" });
		expect(reads).toBe(0);
	});
});

import { generateKeyPairSync } from "node:crypto";
import { skillPackagePublicationStagesV1 } from "@agent-infra/platform-core";
import { publicationFixture } from "./skill-package-consumer.fixture.js";

it("consumes all seven supplier-produced objects and re-verifies after restart without publication", async () => {
	const f = await publicationFixture();
	expect((await f.consumer.verify(f.input)).packageObject).toEqual(
		f.state.objects.zip,
	);
	expect(
		(await createSkillPackageConsumerV1(f.options).verify(f.input)).state
			.operationId,
	).toBe(f.state.operationId);
	expect(f.publications).toBe(1);
});
it.each(skillPackagePublicationStagesV1)(
	"rejects missing original %s evidence",
	async (stage) => {
		const f = await publicationFixture();
		const objects = { ...f.state.objects };
		delete objects[stage];
		f.setState({ ...f.state, objects });
		await expect(f.consumer.verify(f.input)).rejects.toMatchObject({
			code: "dependency_unavailable",
		});
	},
);
it.each([
	{ keyState: "revoked" as const },
	{ trustRevision: "changed" },
	{ policyRevision: "changed" },
	{ scannerId: "other" },
	{ engineVersion: "other" },
	{ rulesetDigest: "b".repeat(64) },
	{ keyId: "different-key" },
	{ allowInternalWithoutApproval: false },
	{ maximumReceiptAgeMs: 1 },
	{ publicKey: generateKeyPairSync("ed25519").publicKey },
])("rejects changed current policy %#", async (patch) => {
	const f = await publicationFixture();
	f.setPolicy(patch);
	await expect(f.consumer.verify(f.input)).rejects.toMatchObject({
		code: "dependency_unavailable",
	});
});
it("rejects source revocation and does not leak dependency errors", async () => {
	const f = await publicationFixture();
	f.denySource();
	await expect(f.consumer.verify(f.input)).rejects.toThrow(
		"Skill package admission rejected",
	);
});
it("rejects trust change during object download", async () => {
	const f = await publicationFixture();
	const download = f.options.storage.download.bind(f.options.storage);
	const consumer = createSkillPackageConsumerV1({
		...f.options,
		storage: {
			download: async (i) => {
				const data = await download(i);
				f.setPolicy({ keyState: "revoked" });
				return data;
			},
		},
	});
	await expect(consumer.verify(f.input)).rejects.toMatchObject({
		code: "dependency_unavailable",
	});
});
it("rejects original publication changing during verification", async () => {
	const f = await publicationFixture();
	let reads = 0;
	const consumer = createSkillPackageConsumerV1({
		...f.options,
		readPublication: async () =>
			++reads === 1 ? f.options.readPublication() : null,
	});
	await expect(consumer.verify(f.input)).rejects.toMatchObject({
		code: "dependency_unavailable",
	});
});
it("checks immutable download metadata and bytes", async () => {
	const f = await publicationFixture();
	for (const patch of [
		{ version: "another" },
		{ etag: "another" },
		{ expectedMetadata: { sizeBytes: 1, mediaType: "application/zip" } },
		{
			expectedMetadata: {
				sizeBytes: f.state.objects.zip!.sizeBytes,
				mediaType: "text/plain",
			},
		},
	]) {
		const download = f.options.storage.download.bind(f.options.storage);
		const consumer = createSkillPackageConsumerV1({
			...f.options,
			storage: { download: (i) => download({ ...i, ...patch }) },
		});
		await expect(consumer.verify(f.input)).rejects.toMatchObject({
			code: "dependency_unavailable",
		});
	}
	const consumer = createSkillPackageConsumerV1({
		...f.options,
		storage: {
			download: async () =>
				new ReadableStream({
					start(c) {
						c.enqueue(Buffer.from("tampered"));
						c.close();
					},
				}),
		},
	});
	await expect(consumer.verify(f.input)).rejects.toMatchObject({
		code: "dependency_unavailable",
	});
});

it.each(skillPackagePublicationStagesV1)(
	"rejects tampered fixed %s bytes",
	async (stage) => {
		const f = await publicationFixture();
		const target = f.state.objects[stage]!;
		const download = f.options.storage.download.bind(f.options.storage);
		const consumer = createSkillPackageConsumerV1({
			...f.options,
			storage: {
				download: async (i) => {
					const stream = await download(i);
					if (i.objectRef !== target.objectRef) return stream;
					const bytes = Buffer.from(await new Response(stream).arrayBuffer());
					bytes[0] = (bytes[0] ?? 0) ^ 1;
					return new ReadableStream({
						start(c) {
							c.enqueue(bytes);
							c.close();
						},
					});
				},
			},
		});
		await expect(consumer.verify(f.input)).rejects.toMatchObject({
			code: "dependency_unavailable",
		});
	},
);
it("rejects a real elapsed scan receipt without renewing or rescanning", async () => {
	const f = await publicationFixture(1_000);
	await f.consumer.verify(f.input);
	const expiresAt = f.state.intents.scan!.evidence!.expiresAt as string;
	await new Promise((resolve) =>
		setTimeout(resolve, Math.max(1, Date.parse(expiresAt) - Date.now() + 10)),
	);
	await expect(f.consumer.verify(f.input)).rejects.toMatchObject({
		code: "dependency_unavailable",
	});
	expect(f.publications).toBe(1);
	expect(f.state.intents.scan!.evidence!.expiresAt).toBe(expiresAt);
});
it("rejects a private signing key supplied to the consumer", async () => {
	const f = await publicationFixture();
	f.setPolicy({ publicKey: generateKeyPairSync("ed25519").privateKey });
	await expect(f.consumer.verify(f.input)).rejects.toMatchObject({
		code: "dependency_unavailable",
	});
});
