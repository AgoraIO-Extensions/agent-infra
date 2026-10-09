import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { connectionProviderCatalogs } from "./provider-catalogs.ts";
import {
	staticSpacesConnectionCatalog as catalog,
	StaticSpacesAdapter,
	staticSpacesOrigins,
	staticSpacesVerificationMatrix,
} from "./static-spaces.ts";
import { staticSpacesExecutorDigest } from "./static-spaces-integrity.ts";

const token = "static-spaces-test-only-credential-canary";
const personal = {
	pk: 17,
	username: "alice@example.test",
	is_active: true,
	is_superuser: false,
};
const identity = () => Response.json({ user: personal });
const invocation = (name: string, input: Record<string, unknown> = {}) => ({
	action: `static-spaces.${name}`,
	actionVersionId: `static-spaces.${name}@v1`,
	credential: { accessToken: token },
	input,
	providerId: catalog.provider,
	providerReleaseId: catalog.providerReleaseId,
});

test("StaticSpaces source digest and real-account publication gate", () => {
	assert.equal(
		staticSpacesExecutorDigest,
		`sha256:${createHash("sha256")
			.update(readFileSync(new URL("./static-spaces.ts", import.meta.url)))
			.digest("hex")}`,
	);
	assert.equal(catalog.actions.length, 7);
	assert.equal(
		catalog.actions.filter((item) => item.effect === "WRITE").length,
		3,
	);
	assert.equal(staticSpacesVerificationMatrix.length, 7);
	assert.ok(
		staticSpacesVerificationMatrix.every(
			(item) => item.status === "UNVERIFIED",
		),
	);
	assert.equal(
		connectionProviderCatalogs.some(
			(item) => item.provider === "static-spaces",
		),
		false,
	);
});

test("StaticSpaces proves stable identity and projects no credential to an Action result", async () => {
	const requests: Request[] = [];
	const adapter = new StaticSpacesAdapter(async (url, init) => {
		requests.push(new Request(url, init));
		return identity();
	});
	const account = await adapter.validateCredential(token);
	assert.equal(account.externalAccount, "17");
	assert.equal(account.displayName, personal.username);
	assert.deepEqual(await adapter.execute(invocation("get_current_user")), {
		id: "17",
		username: personal.username,
	});
	assert.equal(
		requests[0]?.url,
		`${staticSpacesOrigins.identity}/api/v3/core/users/me/`,
	);
	assert.equal(requests[0]?.headers.get("authorization"), `Bearer ${token}`);
	assert.equal(requests[0]?.headers.get("x-authentik-username"), null);
	assert.equal(requests[0]?.redirect, "manual");
});

test("StaticSpaces rejects admin, missing/unstable and inactive identity", async () => {
	for (const user of [
		{ ...personal, is_superuser: true },
		{ ...personal, is_superuser: undefined },
		{ ...personal, pk: null },
		{ ...personal, pk: "" },
		{ ...personal, pk: 0 },
		{ ...personal, username: "../bob" },
		{ ...personal, is_active: false },
		{ ...personal, is_active: undefined },
	]) {
		const adapter = new StaticSpacesAdapter(async () =>
			Response.json({ user }),
		);
		await assert.rejects(adapter.validateCredential(token), {
			providerCredentialInvalid: true,
		});
	}
});

test("StaticSpaces routes all six content Actions with fixed origins and raw payloads", async () => {
	const cases = [
		["list_files", { kind: "user", prefix: "docs" }, "/v1/files", "GET"],
		[
			"download_file",
			{ kind: "shared", slug: "project-y", path: "docs/PRD.md" },
			"/v1/download-file",
			"GET",
		],
		[
			"get_markdown_review",
			{ kind: "public", slug: "project-y", path: "docs/PRD.md" },
			"/v1/markdown-review",
			"GET",
		],
		[
			"publish_space",
			{
				kind: "shared",
				slug: "project-y",
				files: [
					{ relative_path: "docs/PRD.md", content: "# 原文\r\n\n保留 bytes\n" },
				],
			},
			"/v1/publish-space",
			"POST",
		],
		[
			"upload_html",
			{
				kind: "user",
				relative_path: "index.html",
				html: "<!doctype html><p>draft</p>",
			},
			"/v1/upload-html",
			"POST",
		],
		[
			"upload_static_package",
			{
				kind: "public",
				slug: "project-y",
				archive_format: "zip",
				archive_base64: "AAECAw==",
			},
			"/v1/upload-static-package",
			"POST",
		],
	] as const;
	for (const [name, args, path, method] of cases) {
		const requests: Request[] = [];
		const raw = Buffer.from([0, 255, 128, 10]);
		const scope = {
			kind: args.kind,
			slug: args.kind === "user" ? personal.username : "project-y",
		};
		const file = {
			path: "docs/PRD.md",
			url: "https://static-spaces.sh3.agoralab.co/spaces/shared/project-y/docs/PRD.md",
			raw_url:
				"https://static-spaces.sh3.agoralab.co/spaces/shared/project-y/docs/PRD.md",
			review_url:
				"https://static-spaces.sh3.agoralab.co/spaces/shared/project-y/docs/PRD.md?view=review",
			size: 27,
			sha256: "a".repeat(64),
		};
		const response =
			name === "list_files"
				? { ...scope, files: [file] }
				: name === "get_markdown_review"
					? {
							document: { ...file, content: "# 原文\r\n" },
							comments: { etag: "current", threads: [] },
						}
					: name === "publish_space"
						? {
								...scope,
								files_written: [file],
								acl: {
									prefix: "/spaces/shared/project-y/",
									groups: ["viewers"],
									enabled: true,
								},
								groups: {
									owners: "owners",
									managers: "managers",
									viewers: "viewers",
								},
								memberships: [],
								verification: [],
								review_urls: { "docs/PRD.md": file.review_url },
							}
						: name === "upload_static_package"
							? {
									...scope,
									files_written: ["index.html"],
									archive_sha256: "a".repeat(64),
									review_urls: {},
								}
							: { ...scope, ...file };

		const adapter = new StaticSpacesAdapter(async (url, init) => {
			const request = new Request(url, init);
			requests.push(request);
			return requests.length === 1
				? identity()
				: name === "download_file"
					? new Response(raw, {
							headers: { "content-type": "application/octet-stream" },
						})
					: Response.json(response);
		});
		const result = await adapter.execute(invocation(name, args));
		assert.equal(requests.length, 2);
		const request = requests[1];
		assert.ok(request);
		const url = new URL(request.url);
		assert.equal(url.origin, staticSpacesOrigins.api);
		assert.equal(url.pathname, path);
		assert.equal(request.method, method);
		assert.equal(request.headers.get("authorization"), `Bearer ${token}`);
		if (method === "POST") {
			const body = await request.json();
			assert.deepEqual(body, {
				...args,
				overwrite: false,
				...(args.kind === "user" ? { username: personal.username } : {}),
			});
		} else {
			assert.equal(url.searchParams.get("kind"), args.kind);
			assert.equal(
				url.searchParams.get("username"),
				args.kind === "user" ? personal.username : null,
			);
		}
		assert.deepEqual(
			result,
			name === "download_file"
				? {
						contentBase64: raw.toString("base64"),
						size: raw.length,
						sha256: createHash("sha256").update(raw).digest("hex"),
						mimeType: "application/octet-stream",
					}
				: response,
		);
	}
});

test("StaticSpaces rejects identity selectors, unsafe paths, arbitrary URLs and malformed files before egress", async () => {
	let requests = 0;
	const adapter = new StaticSpacesAdapter(async () => {
		requests += 1;
		return identity();
	});
	for (const [name, args] of [
		["list_files", { kind: "user", username: "bob@example.test" }],
		["list_files", { kind: "user", slug: "other" }],
		["list_files", { kind: "shared" }],
		["list_files", { kind: "public", slug: "../bob" }],
		["list_files", { kind: "user", connectionId: "bob-connection" }],
		["list_files", { kind: "user", origin: "https://attacker.test" }],
		["list_files", { kind: "user", toString: "bad" }],
		...[
			"/index.html",
			"../a.md",
			"docs/./a.md",
			"docs\\a.md",
			"docs//a.md",
			"__staticspaces/state/a.json",
			"run.exe",
		].map((path) => ["download_file", { kind: "user", path }]),
		["get_markdown_review", { kind: "user", path: "a.html" }],
		["upload_html", { kind: "user", relative_path: "a.js", html: "x" }],
		["publish_space", { kind: "user", files: [] }],
		[
			"publish_space",
			{
				kind: "user",
				files: [
					{ relative_path: "a.md", content: "x", content_base64: "eA==" },
				],
			},
		],
		[
			"publish_space",
			{
				kind: "user",
				files: [{ relative_path: "a.md", content: "x", overwrite: true }],
			},
		],
		[
			"publish_space",
			{
				kind: "user",
				files: [
					{ relative_path: "a.md", content: "x" },
					{ relative_path: "a.md", content: "y" },
				],
			},
		],
		[
			"upload_static_package",
			{ kind: "user", archive_format: "tar", archive_base64: "eA==" },
		],
		[
			"upload_static_package",
			{ kind: "user", archive_format: "zip", archive_base64: "@@" },
		],
		[
			"upload_static_package",
			{ kind: "user", archive_format: "zip", archive_base64: "" },
		],
	] as Array<[string, Record<string, unknown>]>) {
		await assert.rejects(
			adapter.execute(invocation(name, args)),
			/input is invalid/,
		);
	}
	for (const change of [
		{ providerId: "github" },
		{ providerReleaseId: "static-spaces-connection-v2" },
		{ actionVersionId: "static-spaces.list_files@v2" },
		{ action: "static-spaces.delete_space" },
	]) {
		await assert.rejects(
			adapter.execute({
				...invocation("list_files", { kind: "user" }),
				...change,
			}),
			/input is invalid/,
		);
	}
	assert.equal(requests, 0);
});

test("StaticSpaces preserves non-atomic 4xx, transport and response-lost writes as unknown without retries", async () => {
	for (const status of [400, 401, 403, 409, 429, 500, 302]) {
		let writes = 0;
		const adapter = new StaticSpacesAdapter(async (_url, init) => {
			if (init?.method !== "POST") return identity();
			writes += 1;
			return new Response(`upstream secret: ${token}`, { status });
		});
		await assert.rejects(
			adapter.execute(
				invocation("upload_html", {
					kind: "user",
					relative_path: "index.html",
					html: "x",
				}),
			),
			(error: Error & { submissionUncertain?: boolean }) =>
				error.submissionUncertain === true && !error.message.includes(token),
		);
		assert.equal(writes, 1);
	}
	let writes = 0;
	const adapter = new StaticSpacesAdapter(async (_url, init) => {
		if (init?.method !== "POST") return identity();
		writes += 1;
		throw new TypeError(`transport leak ${token}`);
	});
	await assert.rejects(
		adapter.execute(
			invocation("publish_space", {
				kind: "user",
				files: [{ relative_path: "a.md", content: "x" }],
			}),
		),
		(error: Error & { submissionUncertain?: boolean }) =>
			error.submissionUncertain === true && !error.message.includes(token),
	);
	assert.equal(writes, 1);
});

test("StaticSpaces rejects credential echoes, invalid and oversized/chunked responses", async () => {
	const responses = [
		() => Response.json({ access_token: token }),
		() => new Response(JSON.stringify({ echo: token }).replace("s", "\\u0073")),
		() => new Response("not JSON"),
		() => Response.json([]),
		() => Response.json({}),
		() => Response.json({ error: { code: "PARTIAL_FAILURE" } }),
		() =>
			new Response("x", {
				headers: { "content-length": String(2 * 1024 * 1024 + 1) },
			}),
		() =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(2 * 1024 * 1024));
						controller.enqueue(new Uint8Array(1));
						controller.close();
					},
				}),
			),
	];
	for (const response of responses) {
		const adapter = new StaticSpacesAdapter(async (_url, init) =>
			init?.method === "POST" ? response() : identity(),
		);
		await assert.rejects(
			adapter.execute(
				invocation("upload_html", {
					kind: "user",
					relative_path: "a.html",
					html: "x",
				}),
			),
			(error: Error) => !error.message.includes(token),
		);
	}
	const adapter = new StaticSpacesAdapter(async (url) =>
		String(url).includes("download-file") ? new Response(token) : identity(),
	);
	await assert.rejects(
		adapter.execute(
			invocation("download_file", { kind: "user", path: "a.txt" }),
		),
		/credential material/,
	);
});

test("StaticSpaces preserves read authorization status and rejects identity redirects", async () => {
	for (const status of [401, 403, 302, 429]) {
		const adapter = new StaticSpacesAdapter(
			async () => new Response(token, { status }),
		);
		await assert.rejects(
			adapter.validateCredential(token),
			(error: Error & { providerStatus?: number }) =>
				error.providerStatus === (status === 403 ? 401 : status) &&
				!error.message.includes(token),
		);
	}
});

test("StaticSpaces content ACL denial does not invalidate a proven personal token", async () => {
	const adapter = new StaticSpacesAdapter(async (url) =>
		String(url).includes("/core/users/me/")
			? identity()
			: new Response(token, { status: 403 }),
	);
	await assert.rejects(
		adapter.execute(
			invocation("list_files", { kind: "shared", slug: "project-y" }),
		),
		(
			error: Error & {
				providerStatus?: number;
				providerCredentialInvalid?: boolean;
			},
		) =>
			error.providerStatus === 403 &&
			error.providerCredentialInvalid !== true &&
			!error.message.includes(token),
	);
});
