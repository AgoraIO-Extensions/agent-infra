import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { crc32, gzipSync } from "node:zlib";
import { type Schema, Validator } from "@cfworker/json-schema";
import { staticSpacesExecutorDigest } from "./static-spaces-integrity.ts";
import {
	staticSpacesConnectionCatalog as catalog,
	inspectStandardArchive,
	StaticSpacesAdapter,
} from "./static-spaces-v6.ts";

const identity = {
	user: {
		pk: 951,
		username: "normal@example.invalid",
		is_active: true,
		is_superuser: false,
	},
};
const invoke = (action: string, input: Record<string, unknown>) => ({
	action: `static-spaces.${action}`,
	actionVersionId: `static-spaces.${action}@v6`,
	providerId: "static-spaces",
	providerReleaseId: catalog.providerReleaseId,
	credential: { accessToken: "test-only-normal-token" },
	input,
});
function tar(path: string, bytes: Buffer) {
	const header = Buffer.alloc(512);
	header.write(path);
	header.write("0000644\0", 100);
	header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124);
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
			bytes,
			Buffer.alloc((512 - (bytes.length % 512)) % 512),
			Buffer.alloc(1024),
		]),
	).toString("base64");
}
test("v6 consent declares ordinary targets and preserves immutable implementation digest", () => {
	assert.equal(catalog.actions.length, 7);
	assert.equal(catalog.actions.filter((a) => a.effect === "WRITE").length, 3);
	assert.equal(
		catalog.executorDigest,
		`sha256:${createHash("sha256")
			.update(readFileSync(new URL("./static-spaces-v6.ts", import.meta.url)))
			.update(staticSpacesExecutorDigest)
			.digest("hex")}`,
	);
	for (const kind of ["user", "shared", "public"]) {
		for (const action of catalog.actions.filter((a) =>
			a.name.endsWith("upload_html"),
		)) {
			const input = {
				kind,
				...(kind === "user" ? {} : { slug: "business-docs" }),
				relative_path: "reports/ordinary.html",
				html: "ordinary",
				overwrite: true,
			};
			assert.equal(
				new Validator(action.inputSchema as Schema).validate(input).valid,
				true,
			);
		}
	}
});
test("ordinary personal identity and content ACL denial do not require test groups or invalidate Token", async () => {
	let writes = 0;
	const adapter = new StaticSpacesAdapter(async (url) => {
		if (String(url).includes("/users/me/")) return Response.json(identity);
		writes++;
		return new Response(null, { status: 403 });
	});
	assert.equal(
		(await adapter.validateCredential("test-only-normal-token"))
			.externalAccount,
		"951",
	);
	await assert.rejects(
		adapter.execute(
			invoke("list_files", { kind: "shared", slug: "business-docs" }),
		),
		(error: unknown) =>
			Boolean(
				error &&
					typeof error === "object" &&
					"providerStatus" in error &&
					error.providerStatus === 403 &&
					!(
						"providerCredentialInvalid" in error &&
						error.providerCredentialInvalid
					),
			),
	);
	assert.equal(writes, 1);
	assert.equal(
		(await adapter.execute(invoke("get_current_user", {}))).id,
		"951",
	);
});
test("user targets derive username and writes default false with explicit overwrite preserved", async () => {
	for (const overwrite of [undefined, true]) {
		let body: Record<string, unknown> = {};
		const html = "<p>ordinary</p>";
		const path = "reports/page.html";
		const adapter = new StaticSpacesAdapter(async (url, init) => {
			if (String(url).includes("/users/me/")) return Response.json(identity);
			body = JSON.parse(String(init?.body));
			const absolute = `/spaces/users/${identity.user.username}/${path}`;
			return Response.json({
				kind: "user",
				slug: identity.user.username,
				path: absolute,
				url: `https://static-spaces.sh3.agoralab.co${absolute}`,
				size: Buffer.byteLength(html),
				sha256: createHash("sha256").update(html).digest("hex"),
			});
		});
		await adapter.execute(
			invoke("upload_html", {
				kind: "user",
				relative_path: path,
				html,
				...(overwrite === undefined ? {} : { overwrite }),
			}),
		);
		assert.equal(body.username, identity.user.username);
		assert.equal(body.overwrite, overwrite ?? false);
		await assert.rejects(
			adapter.execute(
				invoke("upload_html", {
					kind: "user",
					username: "other",
					relative_path: path,
					html,
				}),
			),
		);
	}
});
test("normal binary archive needs no marker but still rejects traversal and reserved paths", () => {
	inspectStandardArchive(
		tar("assets/logo.png", Buffer.from([0, 1, 255, 4])),
		"tgz",
	);
	for (const path of [
		"../x.png",
		"/x.png",
		"a//x.png",
		"__staticspaces/x.png",
		"assets/../x.png",
		"a\\x.png",
		"a/x.exe",
	])
		assert.throws(() =>
			inspectStandardArchive(tar(path, Buffer.from([0, 1])), "tgz"),
		);
});
test("new version cannot execute archived or spoofed provider identities", async () => {
	const adapter = new StaticSpacesAdapter(async () => Response.json(identity));
	await assert.rejects(
		adapter.execute({
			...invoke("get_current_user", {}),
			actionVersionId: "static-spaces.get_current_user@v5",
		}),
	);
	await assert.rejects(
		adapter.execute({ ...invoke("get_current_user", {}), providerId: "other" }),
	);
});

test("ordinary ZIP binary files preserve central-directory integrity and reject symlinks", () => {
	const name = Buffer.from("assets/picture.png");
	const content = Buffer.from([0, 255, 1, 2]);
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50);
	local.writeUInt32LE(crc32(content), 14);
	local.writeUInt32LE(content.length, 18);
	local.writeUInt32LE(content.length, 22);
	local.writeUInt16LE(name.length, 26);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50);
	central.writeUInt32LE(crc32(content), 16);
	central.writeUInt32LE(content.length, 20);
	central.writeUInt32LE(content.length, 24);
	central.writeUInt16LE(name.length, 28);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length + name.length, 12);
	end.writeUInt32LE(local.length + name.length + content.length, 16);
	const encoded = () =>
		Buffer.concat([local, name, content, central, name, end]).toString(
			"base64",
		);
	inspectStandardArchive(encoded(), "zip");
	central.writeUInt32LE(0xa0000000, 38);
	assert.throws(() => inspectStandardArchive(encoded(), "zip"));
	central.writeUInt32LE(0, 38);
	central.writeUInt32LE(12345, 16);
	assert.throws(() => inspectStandardArchive(encoded(), "zip"));
});
