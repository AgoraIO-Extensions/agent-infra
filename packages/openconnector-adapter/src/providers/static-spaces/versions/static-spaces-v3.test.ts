import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { crc32, gzipSync } from "node:zlib";
import { type Schema, Validator } from "@cfworker/json-schema";
import { connectionProviderCatalogs } from "../../../provider-catalogs.ts";
import { staticSpacesExecutorDigest } from "./static-spaces-integrity.ts";
import {
	staticSpacesConnectionCatalog as catalog,
	inspectPilotArchive,
	StaticSpacesAdapter,
	staticSpacesPilot,
} from "./static-spaces-v3.ts";

const run = staticSpacesPilot.canaryRunId;
const path = `connection-onboarding/${run}/index.html`;
const marker = `connection-e2e:${run}`;
test("current catalog and valid v3 execution use the new version", async (t) => {
	t.mock.method(
		Date,
		"now",
		() => Date.parse(staticSpacesPilot.startsAt) + 60000,
	);
	assert.equal(
		connectionProviderCatalogs.find((c) => c.provider === "static-spaces")
			?.providerReleaseId,
		catalog.providerReleaseId,
	);
	let requests = 0;
	const adapter = new StaticSpacesAdapter(async () => {
		requests++;
		return Response.json({
			user: {
				pk: 841,
				username: "pilot@example.invalid",
				is_active: true,
				is_superuser: false,
			},
		});
	});
	const result = await adapter.execute({
		action: "static-spaces.get_current_user",
		actionVersionId: "static-spaces.get_current_user@v3",
		providerId: "static-spaces",
		providerReleaseId: catalog.providerReleaseId,
		credential: { accessToken: "test-only-token" },
		input: {},
	});
	assert.equal(result.id, "841");
	assert.ok(requests > 0);
});
function tar(name: string, content: string) {
	const data = Buffer.from(content);
	const header = Buffer.alloc(512);
	header.write(name);
	header.write("0000644\0", 100);
	header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
	header.fill(32, 148, 156);
	header[156] = 48;
	header.write(
		`${header
			.reduce((sum, byte) => sum + byte, 0)
			.toString(8)
			.padStart(6, "0")}\0 `,
		148,
	);
	return gzipSync(
		Buffer.concat([
			header,
			data,
			Buffer.alloc((512 - (data.length % 512)) % 512),
			Buffer.alloc(1024),
		]),
	).toString("base64");
}
test("pilot has seven separately consented scoped actions without changing v1", () => {
	assert.equal(catalog.actions.length, 7);
	assert.equal(
		catalog.providerReleaseId,
		"static-spaces-connection-v3-supervised",
	);
	for (const action of catalog.actions) {
		assert.ok(action.id.endsWith("@v3"));
		if (!action.name.endsWith("get_current_user")) {
			assert.deepEqual(
				(action.inputSchema.properties as Record<string, unknown>)?.kind,
				{
					const: "shared",
				},
			);
			assert.deepEqual(
				(action.inputSchema.properties as Record<string, unknown>)?.slug,
				{
					const: "connection-test",
				},
			);
		}
	}
	assert.equal(
		Date.parse(staticSpacesPilot.expiresAt) -
			Date.parse(staticSpacesPilot.startsAt),
		86400000,
	);
	assert.equal(
		catalog.executorDigest,
		`sha256:${createHash("sha256")
			.update(readFileSync(new URL("./static-spaces-v3.ts", import.meta.url)))
			.update(staticSpacesExecutorDigest)
			.digest("hex")}`,
	);
});
test("archive ownership is checked before upstream submission", () => {
	inspectPilotArchive(tar(path, marker), "tgz");
	inspectPilotArchive(tar(path, marker), "tar.gz");
	for (const [name, content] of [
		["business/index.html", marker],
		[path, "no marker"],
		[`connection-onboarding/${run}/../index.html`, marker],
	]) {
		assert.throws(
			() => inspectPilotArchive(tar(name ?? "", content ?? ""), "tgz"),
			/admission denied/,
		);
	}
	assert.throws(() =>
		inspectPilotArchive(Buffer.alloc(12).toString("base64"), "zip"),
	);
});
test("wrong account, target and overwrite never submit an external write", async (t) => {
	t.mock.method(
		Date,
		"now",
		() => Date.parse(staticSpacesPilot.startsAt) + 60000,
	);
	let writes = 0;
	const adapter = new StaticSpacesAdapter(async (_url, options) => {
		if (options?.method === "POST") writes++;
		return Response.json({
			user: {
				pk: 17,
				username: "other@example.invalid",
				is_active: true,
				is_superuser: false,
			},
		});
	});
	await assert.rejects(() => adapter.validateCredential("test-token"));
	await assert.rejects(() =>
		adapter.execute({
			action: "static-spaces.upload_html",
			actionVersionId: "static-spaces.upload_html@v3",
			providerId: "static-spaces",
			providerReleaseId: catalog.providerReleaseId,
			credential: { accessToken: "test-token" },
			input: {
				kind: "public",
				slug: "connection-test",
				relative_path: path,
				html: marker,
				overwrite: true,
			},
		}),
	);
	assert.equal(writes, 0);
});
test("target, overwrite and ownership each reject before any external request", async (t) => {
	t.mock.method(
		Date,
		"now",
		() => Date.parse(staticSpacesPilot.startsAt) + 60000,
	);
	let requests = 0;
	const adapter = new StaticSpacesAdapter(async () => {
		requests++;
		throw new Error("unexpected fetch");
	});
	const base = {
		action: "static-spaces.upload_html",
		actionVersionId: "static-spaces.upload_html@v3",
		providerId: "static-spaces",
		providerReleaseId: catalog.providerReleaseId,
		credential: { accessToken: "test-token" },
	};
	for (const input of [
		{
			kind: "public",
			slug: "connection-test",
			relative_path: path,
			html: marker,
			overwrite: false,
		},
		{
			kind: "shared",
			slug: "other",
			relative_path: path,
			html: marker,
			overwrite: false,
		},
		{
			kind: "shared",
			slug: "connection-test",
			relative_path: path,
			html: marker,
			overwrite: true,
		},
		{
			kind: "shared",
			slug: "connection-test",
			relative_path: "business/index.html",
			html: marker,
			overwrite: false,
		},
		{
			kind: "shared",
			slug: "connection-test",
			relative_path: path,
			html: "missing marker",
			overwrite: false,
		},
	])
		await assert.rejects(
			() => adapter.execute({ ...base, input }),
			/admission denied/,
		);
	assert.equal(requests, 0);
});
test("identity preflight rejects oversized streams, compression and wrong media", async (t) => {
	t.mock.method(
		Date,
		"now",
		() => Date.parse(staticSpacesPilot.startsAt) + 60000,
	);
	const me = () =>
		Response.json({
			user: {
				pk: 841,
				username: "pilot@example.invalid",
				is_active: true,
				is_superuser: false,
				groups: [
					{ pk: staticSpacesPilot.ownerGroupId },
					{ pk: staticSpacesPilot.viewerGroupId },
				],
			},
		});
	for (const response of [
		new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array(2097153));
					controller.close();
				},
			}),
			{ headers: { "content-type": "application/json" } },
		),
		new Response("{}", {
			headers: {
				"content-type": "application/json",
				"content-encoding": "gzip",
			},
		}),
		new Response("{}", { headers: { "content-type": "text/html" } }),
	]) {
		let writes = 0;
		const adapter = new StaticSpacesAdapter(async (url, options) => {
			if (options?.method === "POST") writes++;
			assert.ok(
				options?.signal || String(url).endsWith("/api/v3/core/users/me/"),
			);
			return String(url).includes("/applications/") ? response : me();
		});
		await assert.rejects(() =>
			adapter.execute({
				action: "static-spaces.upload_html",
				actionVersionId: "static-spaces.upload_html@v3",
				providerId: "static-spaces",
				providerReleaseId: catalog.providerReleaseId,
				credential: { accessToken: "test-token" },
				input: {
					kind: "shared",
					slug: "connection-test",
					relative_path: path,
					html: marker,
					overwrite: false,
				},
			}),
		);
		assert.equal(writes, 0);
	}
});
test("ZIP directory metadata cannot redirect upstream extraction away from inspected ownership", () => {
	const name = Buffer.from(path);
	const bytes = Buffer.from(marker);
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50);
	local.writeUInt32LE(crc32(bytes), 14);
	local.writeUInt32LE(bytes.length, 18);
	local.writeUInt32LE(bytes.length, 22);
	local.writeUInt16LE(name.length, 26);
	const directory = Buffer.alloc(46);
	directory.writeUInt32LE(0x02014b50);
	directory.writeUInt32LE(crc32(bytes), 16);
	directory.writeUInt32LE(bytes.length, 20);
	directory.writeUInt32LE(bytes.length, 24);
	directory.writeUInt16LE(name.length, 28);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(directory.length + name.length, 12);
	end.writeUInt32LE(local.length + name.length + bytes.length, 16);
	const archive = Buffer.concat([local, name, bytes, directory, name, end]);
	inspectPilotArchive(archive.toString("base64"), "zip");
	const bad = Buffer.from(archive);
	bad.writeUInt32LE(0, bad.length - 6);
	assert.throws(() => inspectPilotArchive(bad.toString("base64"), "zip"));
	const inconsistent = Buffer.from(archive);
	inconsistent.writeUInt32LE(1, local.length + name.length + bytes.length + 24);
	assert.throws(() =>
		inspectPilotArchive(inconsistent.toString("base64"), "zip"),
	);
});

test("v3 prefix Schema rejects Adapter-invalid paths before submission", () => {
	const action = catalog.actions.find(
		(action) => action.name === "static-spaces.list_files",
	);
	assert.ok(action);
	for (const prefix of ["a", "folder/file", `connection-onboarding/${run}`]) {
		assert.equal(
			new Validator(action.inputSchema as Schema, "2020-12", false).validate({
				kind: "shared",
				slug: "connection-test",
				prefix,
			}).valid,
			true,
		);
	}
	for (const prefix of [
		"",
		"/folder",
		"folder/",
		"folder//file",
		".",
		"..",
		"folder/../file",
		"folder/./file",
		"__staticspaces/file",
		"folder/__staticspaces/file",
		"folder\\file",
		"folder\u0000file",
		"folder\u007ffile",
		"folder\n",
		"folder\r",
	]) {
		assert.equal(
			new Validator(action.inputSchema as Schema, "2020-12", false).validate({
				kind: "shared",
				slug: "connection-test",
				prefix,
			}).valid,
			false,
			JSON.stringify(prefix),
		);
	}
	assert.equal(staticSpacesPilot.approvalIssue, "1714");
});
