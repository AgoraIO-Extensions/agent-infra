import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createPinnedProviderFetch } from "../packages/openconnector-adapter/src/provider-fetch.ts";
import {
	staticSpacesConnectionCatalog as catalog,
	StaticSpacesAdapter,
	staticSpacesOrigins,
} from "../packages/openconnector-adapter/src/providers/static-spaces/versions/static-spaces.ts";

const target = {
	externalAccount: "841",
	slug: "connection-test",
	ownerGroupId: "5c8d58a6-4732-4e7a-bf3e-c0174e771aa1",
	viewerGroupId: "9ba88b80-f9fb-43c8-8c91-684f0bbcdef0",
	applicationId: "0c1e6e33-6750-4127-9d72-157e8899ddcd",
};

// Supervised, opt-in canary. This does not publish a catalog or create a Grant.
export async function runStaticSpacesOnboarding({
	token,
	revokedToken,
	slug,
	transportFactory = createPinnedProviderFetch,
}) {
	assert.ok(token && revokedToken && token !== revokedToken);
	assert.match(slug, /^[a-z0-9][a-z0-9._-]{0,62}$/);
	assert.equal(slug, target.slug);
	const transport = transportFactory({
		origins: Object.values(staticSpacesOrigins),
	});
	const adapter = new StaticSpacesAdapter(transport.fetch);
	const runId = `static-spaces-${randomUUID()}`;
	const prefix = `connection-onboarding/${runId}`;
	const marker = `connection-e2e:${runId}`;
	const scope = { kind: "shared", slug };
	const files = new Map();
	const calls = [];
	const evidence = {
		provider: catalog.provider,
		providerReleaseId: catalog.providerReleaseId,
		executorDigest: catalog.executorDigest,
		externalAccount: target.externalAccount,
		containerId: target.applicationId,
		runId,
		calls,
		status: "FAILED",
		cleanup: "NOT_RUN",
		resources: [],
		verificationLayer: "DIRECT_ADAPTER_WITH_REAL_PROVIDER",
	};
	let failure = false;
	const invoke = (name, input = {}, executor = adapter, credential = token) =>
		executor.execute({
			action: `static-spaces.${name}`,
			actionVersionId: `static-spaces.${name}@v1`,
			credential: { accessToken: credential },
			input,
			providerId: catalog.provider,
			providerReleaseId: catalog.providerReleaseId,
		});
	const call = async (name, input = {}) => {
		const result = await invoke(name, input);
		assert.ok(!JSON.stringify(result).includes(token));
		calls.push({
			actionVersionId: `static-spaces.${name}@v1`,
			status: "SUCCEEDED",
		});
		return result;
	};
	const denied = async (name, input, credential, expected) => {
		await assert.rejects(invoke(name, input, adapter, credential), expected);
	};
	try {
		const identity = await adapter.validateCredential(token);
		assert.equal(identity.externalAccount, target.externalAccount);
		const identityResponse = await transport.fetch(
			`${staticSpacesOrigins.identity}/api/v3/core/users/me/`,
			{
				headers: { authorization: `Bearer ${token}` },
				redirect: "manual",
				signal: AbortSignal.timeout(30_000),
			},
		);
		assert.equal(identityResponse.status, 200);
		const owner = (await identityResponse.json()).user;
		assert.equal(String(owner.pk), target.externalAccount);
		for (const id of [target.ownerGroupId, target.viewerGroupId]) {
			assert.ok(owner.groups.some((group) => group.pk === id));
		}
		const applicationResponse = await transport.fetch(
			`${staticSpacesOrigins.identity}/api/v3/core/applications/?slug=static-spaces-shared-${slug}`,
			{
				headers: { authorization: `Bearer ${token}` },
				redirect: "manual",
				signal: AbortSignal.timeout(30_000),
			},
		);
		evidence.containerPreflightHttp = applicationResponse.status;
		assert.equal(applicationResponse.status, 200);
		const matches = (await applicationResponse.json()).results.filter(
			(item) => item.slug === `static-spaces-shared-${slug}`,
		);
		assert.equal(matches.length, 1);
		const application = matches[0];
		assert.equal(application.pk, target.applicationId);
		assert.equal(application.slug, `static-spaces-shared-${slug}`);
		assert.equal(
			application.launch_url,
			`https://static-spaces.sh3.agoralab.co/spaces/shared/${slug}/`,
		);
		assert.equal((await call("get_current_user")).id, identity.externalAccount);
		await denied("get_current_user", {}, "invalid-test-only-token", {
			providerCredentialInvalid: true,
		});
		await denied("get_current_user", {}, revokedToken, {
			providerCredentialInvalid: true,
		});
		assert.equal(
			(await adapter.validateCredential(token)).externalAccount,
			identity.externalAccount,
		);
		await denied(
			"download_file",
			{ kind: "shared", slug: `denied-${randomUUID()}`, path: "canary.md" },
			token,
			{ providerStatus: 403, providerCredentialInvalid: false },
		);
		await denied(
			"list_files",
			{ kind: "user", username: "another-account@example.invalid" },
			token,
			{ providerCode: "invalid_input" },
		);
		await call("list_files", scope);
		const mdPath = `${prefix}/canary.md`;
		const md = `# StaticSpaces onboarding\n\n${marker}.\n`;
		files.set(mdPath, Buffer.from(md));
		const publication = await call("publish_space", {
			...scope,
			overwrite: false,
			files: [{ relative_path: mdPath, content: md }],
		});
		assert.equal(publication.application.application.pk, target.applicationId);
		assert.equal(publication.groups.owners.group.pk, target.ownerGroupId);
		assert.equal(publication.groups.viewers.group.pk, target.viewerGroupId);
		const downloaded = await call("download_file", { ...scope, path: mdPath });
		assert.equal(
			Buffer.from(downloaded.contentBase64, "base64").toString(),
			md,
		);
		const review = await call("get_markdown_review", {
			...scope,
			path: mdPath,
		});
		assert.equal(review.document.content, md);
		const htmlPath = `${prefix}/canary.html`;
		const html = `<!doctype html><title>Connection canary</title><p>${marker}</p>`;
		files.set(htmlPath, Buffer.from(html));
		await call("upload_html", {
			...scope,
			relative_path: htmlPath,
			html,
			overwrite: false,
		});
		// A deterministic, uncompressed ZIP, using only built-in APIs.
		const packagePath = `${prefix}/package.txt`;
		const packageBytes = Buffer.from(`${marker}\n`);
		files.set(packagePath, packageBytes);
		await call("upload_static_package", {
			...scope,
			archive_format: "zip",
			archive_base64: storedZip(packagePath, packageBytes).toString("base64"),
			overwrite: false,
		});
		for (const [path, bytes] of files) {
			const result = await invoke("download_file", { ...scope, path });
			assert.equal(result.size, bytes.length);
			assert.equal(
				result.sha256,
				createHash("sha256").update(bytes).digest("hex"),
			);
		}
		await denied(
			"upload_html",
			{ ...scope, relative_path: htmlPath, html, overwrite: false },
			token,
			{ providerStatus: 409, submissionUncertain: true },
		);
		let submissions = 0;
		const lostPath = `${prefix}/response-lost.html`;
		const lostBytes = Buffer.from(
			`<!doctype html><title>Response lost canary</title><p>${marker}</p>`,
		);
		files.set(lostPath, lostBytes);
		const lost = new StaticSpacesAdapter(async (url, init) => {
			const response = await transport.fetch(url, init);
			if (init?.method === "POST") {
				submissions++;
				assert.equal(response.status, 200);
				await response.arrayBuffer();
				throw new Error("Controlled loss after real submission");
			}
			return response;
		});
		await assert.rejects(
			invoke(
				"upload_html",
				{
					...scope,
					relative_path: lostPath,
					html: lostBytes.toString(),
					overwrite: false,
				},
				lost,
			),
			{ submissionUncertain: true },
		);
		assert.equal(submissions, 1);
		const readback = await invoke("download_file", {
			...scope,
			path: lostPath,
		});
		assert.equal(
			readback.sha256,
			createHash("sha256").update(lostBytes).digest("hex"),
		);
		evidence.lifecycle =
			"REVOKED_TOKEN_REJECTED_AND_CURRENT_TOKEN_REAUTHENTICATED";
		evidence.responseLost = {
			submissions,
			submissionUncertain: true,
			realEffectReadback: true,
		};
		evidence.status = "SUCCEEDED";
	} catch (error) {
		failure = true;
		evidence.failure = {
			code: "CANARY_FAILED",
			...(typeof error.providerStatus === "number"
				? { providerStatus: error.providerStatus }
				: {}),
		};
	} finally {
		const cleanupFailures = [];
		for (const [path, bytes] of files) {
			const resource = {
				path,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				cleanup: "FAILED",
			};
			evidence.resources.push(resource);
			try {
				assert.ok(path.startsWith(`${prefix}/`));
				assert.ok(bytes.includes(Buffer.from(marker)));
				const actual = await invoke("download_file", { ...scope, path });
				assert.equal(actual.sha256, resource.sha256);
				assert.ok(
					Buffer.from(actual.contentBase64, "base64").includes(
						Buffer.from(marker),
					),
				);
				const response = await transport.fetch(
					`${staticSpacesOrigins.api}/v1/delete-file`,
					{
						method: "POST",
						headers: {
							authorization: `Bearer ${token}`,
							"content-type": "application/json",
						},
						body: JSON.stringify({ ...scope, relative_path: path }),
						redirect: "manual",
						signal: AbortSignal.timeout(30_000),
					},
				);
				assert.equal(response.status, 200);
				assert.equal((await response.json()).deleted, true);
				resource.cleanup = "DELETED";
			} catch (error) {
				if (error.providerStatus === 404) resource.cleanup = "NOT_FOUND";
				else cleanupFailures.push(path);
			}
		}
		try {
			if (files.size) {
				const remaining = await invoke("list_files", scope);
				assert.ok(
					remaining.files.every((file) => !file.path.startsWith(`${prefix}/`)),
				);
			}
		} catch {
			cleanupFailures.push("READBACK_FAILED");
		}
		try {
			await transport.close();
		} catch {
			cleanupFailures.push("TRANSPORT_CLOSE_FAILED");
		}
		evidence.cleanup = cleanupFailures.length ? "FAILED" : "SUCCEEDED";
		if (cleanupFailures.length) {
			failure = true;
			evidence.cleanupFailures = cleanupFailures;
		}
	}
	if (failure) {
		evidence.status = "FAILED";
		throw Object.assign(
			new Error("StaticSpaces onboarding failed; inspect redacted evidence"),
			{ evidence },
		);
	}
	return evidence;
}

function storedZip(path, bytes) {
	const name = Buffer.from(path);
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++)
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	crc = (crc ^ 0xffffffff) >>> 0;
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt32LE(crc, 14);
	local.writeUInt32LE(bytes.length, 18);
	local.writeUInt32LE(bytes.length, 22);
	local.writeUInt16LE(name.length, 26);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt32LE(crc, 16);
	central.writeUInt32LE(bytes.length, 20);
	central.writeUInt32LE(bytes.length, 24);
	central.writeUInt16LE(name.length, 28);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length + name.length, 12);
	end.writeUInt32LE(local.length + name.length + bytes.length, 16);
	return Buffer.concat([local, name, bytes, central, name, end]);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const environment = process.env;
	assert.equal(environment.CONNECTION_STATIC_SPACES_E2E_ENABLED, "true");
	let evidence;
	try {
		evidence = await runStaticSpacesOnboarding({
			token: readFileSync(
				environment.CONNECTION_STATIC_SPACES_TOKEN_FILE,
				"utf8",
			).trim(),
			revokedToken: readFileSync(
				environment.CONNECTION_STATIC_SPACES_REVOKED_TOKEN_FILE,
				"utf8",
			).trim(),
			slug: environment.CONNECTION_STATIC_SPACES_TEST_SLUG,
		});
	} catch (error) {
		evidence = error.evidence ?? { status: "PRECHECK_FAILED" };
		process.exitCode = 1;
	}
	writeFileSync(
		environment.CONNECTION_STATIC_SPACES_EVIDENCE_FILE,
		`${JSON.stringify(evidence, null, 2)}\n`,
		{ mode: 0o600 },
	);
	console.log(JSON.stringify(evidence));
}
