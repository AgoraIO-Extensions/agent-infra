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

function publicationResponse(input: Record<string, unknown>, created = true) {
	const kind = String(input.kind);
	const slug = kind === "user" ? personal.username : String(input.slug);
	const pathPrefix = `/spaces/${kind === "user" ? "users" : kind}/${slug}/`;
	const origin = "https://static-spaces.sh3.agoralab.co";
	const roles =
		kind === "user"
			? ["viewers"]
			: kind === "shared"
				? ["owners", "managers", "viewers"]
				: ["owners", "managers"];
	const groupName = (role: string) =>
		`static-spaces-${kind === "user" ? "users" : kind}-${slug}-${role}`;
	const groups = Object.fromEntries(
		roles.map((role) => [
			role,
			{
				created,
				group: {
					pk: `group-${role}`,
					name: groupName(role),
					is_superuser: false,
				},
			},
		]),
	);
	const files = input.files as Array<{
		relative_path: string;
		content?: string;
		content_base64?: string;
	}>;
	const filesWritten = files.map((file) => {
		const bytes =
			file.content !== undefined
				? Buffer.from(file.content)
				: Buffer.from(file.content_base64 ?? "", "base64");
		const path = pathPrefix + file.relative_path;
		const url = origin + path;
		return {
			kind,
			slug,
			path,
			url,
			size: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			...(/\.(md|markdown)$/i.test(path)
				? { raw_url: url, review_url: `${url}?view=review` }
				: {}),
		};
	});
	let normalized =
		slug.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "space";
	if (normalized !== slug)
		normalized += `-${createHash("sha256").update(slug).digest("hex").slice(0, 8)}`;
	return {
		space: slug,
		kind,
		slug,
		path_prefix: pathPrefix,
		url_prefix: origin + pathPrefix,
		files_written: filesWritten,
		acl: {
			prefix: pathPrefix,
			groups: kind === "public" ? "" : groupName("viewers"),
			enabled: true,
		},
		...(kind === "user" ? { group: groups.viewers } : { groups }),
		...(kind === "shared"
			? {
					application: {
						created,
						application: {
							pk: "app",
							slug: `static-spaces-shared-${normalized}`,
							launch_url: origin + pathPrefix,
						},
						binding: {
							target: "app",
							group: "group-viewers",
							enabled: true,
							negate: false,
						},
					},
				}
			: {}),
		memberships:
			created || kind === "user"
				? roles.map((role) => ({
						username: personal.username,
						group: groupName(role),
						member: true,
					}))
				: [],
		verification:
			created || kind === "user"
				? [
						{
							username: personal.username,
							path: pathPrefix,
							allowed: true,
							status: 200,
						},
					]
				: [],
		review_urls: Object.fromEntries(
			filesWritten
				.filter((file) => "review_url" in file)
				.map((file) => [file.path.slice(pathPrefix.length), file.review_url]),
		),
	};
}

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
		const slug = args.kind === "user" ? personal.username : "project-y";
		const prefix = `/spaces/${args.kind === "user" ? "users" : args.kind}/${slug}/`;
		const scope = {
			space: slug,
			kind: args.kind,
			slug,
			path_prefix: prefix,
			url_prefix: `https://static-spaces.sh3.agoralab.co${prefix}`,
		};
		const file = {
			path: "docs/PRD.md",
			url: `${scope.url_prefix}docs/PRD.md`,
			raw_url: `${scope.url_prefix}docs/PRD.md`,
			review_url: `${scope.url_prefix}docs/PRD.md?view=review`,
			size: 27,
			sha256: "a".repeat(64),
			updated_at: "2026-10-09T00:00:00Z",
		};
		const response =
			name === "list_files"
				? { ...scope, files: [file] }
				: name === "get_markdown_review"
					? {
							document: {
								kind: args.kind,
								slug,
								...file,
								content: "# 原文\r\n",
							},
							comments: {
								etag: "current",
								updated_at: null,
								thread_count: 0,
								threads: [],
							},
						}
					: name === "publish_space"
						? publicationResponse(args)
						: name === "upload_static_package"
							? {
									...scope,
									files_written: ["index.html"],
									archive_sha256: createHash("sha256")
										.update(Buffer.from("AAECAw==", "base64"))
										.digest("hex"),
									review_urls: {},
								}
							: {
									...scope,
									path: prefix + "index.html",
									url: scope.url_prefix + "index.html",
									size: Buffer.byteLength("<!doctype html><p>draft</p>"),
									sha256: createHash("sha256")
										.update("<!doctype html><p>draft</p>")
										.digest("hex"),
								};

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
		const expected = structuredClone(response);
		if (name === "get_markdown_review") {
			const document = (expected as { document: Record<string, unknown> })
				.document;
			delete document.url;
			delete document.updated_at;
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
				: expected,
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

test("StaticSpaces applies Content-Type, no-compression and nested JSON output contracts", async () => {
	const input = { kind: "public", slug: "project-y", path: "docs/PRD.md" };
	for (const response of [
		() =>
			new Response(
				JSON.stringify({ kind: "public", slug: "project-y", files: [] }),
				{ headers: { "content-type": "text/html" } },
			),
		() =>
			Response.json(
				{ kind: "public", slug: "project-y", files: [] },
				{ headers: { "content-encoding": "gzip" } },
			),
		() =>
			Response.json({
				document: {
					kind: "public",
					slug: "project-y",
					path: "docs/PRD.md",
					content: "text",
					size: 4,
					sha256: "a".repeat(64),
					raw_url: "https://example.test/raw",
					review_url: "https://example.test/review",
				},
				comments: {
					etag: "x",
					updated_at: null,
					thread_count: 1,
					threads: [
						{
							id: "thread",
							anchor: { type: "document", document_sha256: "a".repeat(64) },
							comments: [
								{
									id: "comment",
									author_email: "a@example.test",
									body: { secret: "unexpected" },
									created_at: "now",
									edited_at: null,
									deleted_at: null,
									can_edit: true,
									can_delete: true,
								},
							],
						},
					],
				},
			}),
	]) {
		const adapter = new StaticSpacesAdapter(async (url) =>
			String(url).includes("/core/users/me/") ? identity() : response(),
		);
		await assert.rejects(
			adapter.execute(invocation("get_markdown_review", input)),
		);
	}
	const adapter = new StaticSpacesAdapter(async (url) =>
		String(url).includes("/core/users/me/")
			? identity()
			: Response.json({
					kind: "user",
					slug: personal.username,
					files: [],
					unexpected_private_field: "omit-me",
				}),
	);
	assert.deepEqual(
		await adapter.execute(invocation("list_files", { kind: "user" })),
		{ kind: "user", slug: personal.username, files: [] },
	);
});

test("StaticSpaces requires complete publication receipts and preserves legitimate managed-space updates", async () => {
	const input = {
		kind: "shared",
		slug: "project.y",
		files: [{ relative_path: "docs/PRD.md", content: "# 原文\r\n" }],
	};
	for (const created of [true, false]) {
		const expected = publicationResponse(input, created);
		const adapter = new StaticSpacesAdapter(async (url) =>
			String(url).includes("/core/users/me/")
				? identity()
				: Response.json(expected),
		);
		assert.deepEqual(
			await adapter.execute(invocation("publish_space", input)),
			expected,
		);
	}
	for (const kind of ["user", "public"]) {
		const target =
			kind === "user" ? { kind, files: input.files } : { ...input, kind };
		const expected = publicationResponse(target);
		const adapter = new StaticSpacesAdapter(async (url) =>
			String(url).includes("/core/users/me/")
				? identity()
				: Response.json(expected),
		);
		assert.deepEqual(
			await adapter.execute(invocation("publish_space", target)),
			expected,
		);
	}

	for (const edit of [
		(result: Record<string, unknown>) => {
			result.verification = [
				{
					username: personal.username,
					path: "/spaces/shared/project.y/",
					allowed: false,
					status: 403,
				},
			];
		},
		(result: Record<string, unknown>) => {
			result.verification = [];
		},
		(result: Record<string, unknown>) => {
			result.memberships = [];
		},
		(result: Record<string, unknown>) => {
			(result.acl as Record<string, unknown>).enabled = false;
		},
		(result: Record<string, unknown>) => {
			const app = result.application as { binding: Record<string, unknown> };
			app.binding.negate = true;
		},
		(result: Record<string, unknown>) => {
			const files = result.files_written as Record<string, unknown>[];
			if (files[0]) files[0].sha256 = "b".repeat(64);
		},
	]) {
		const malformed = publicationResponse(input) as Record<string, unknown>;
		edit(malformed);
		let writes = 0;
		const adapter = new StaticSpacesAdapter(async (url, init) => {
			if (String(url).includes("/core/users/me/")) return identity();
			if (init?.method === "POST") writes++;
			return Response.json(malformed);
		});
		await assert.rejects(adapter.execute(invocation("publish_space", input)));
		assert.equal(writes, 1);
	}
});

test("StaticSpaces upload byte receipts reject stale size, hash, target and archive digests without retry", async () => {
	const html = "<!doctype html><p>中文\r\n</p>";
	const args = { kind: "user", relative_path: "index.html", html };
	const path = `/spaces/users/${personal.username}/index.html`;
	const receipt = {
		kind: "user",
		slug: personal.username,
		path,
		url: `https://static-spaces.sh3.agoralab.co${path}`,
		size: Buffer.byteLength(html),
		sha256: createHash("sha256").update(html).digest("hex"),
	};
	const execute = async (
		name: string,
		input: Record<string, unknown>,
		output: Record<string, unknown>,
	) => {
		let writes = 0;
		const adapter = new StaticSpacesAdapter(async (url, init) => {
			if (String(url).includes("/core/users/me/")) return identity();
			if (init?.method === "POST") writes++;
			return Response.json(output);
		});
		const result = adapter.execute(invocation(name, input));
		return { result, writes: () => writes };
	};
	const good = await execute("upload_html", args, receipt);
	assert.deepEqual(await good.result, receipt);
	for (const change of [
		{ size: receipt.size + 1 },
		{ sha256: "0".repeat(64) },
		{ path: "/spaces/users/other/index.html" },
		{ url: "https://attacker.example/index.html" },
	]) {
		const checked = await execute("upload_html", args, {
			...receipt,
			...change,
		});
		await assert.rejects(checked.result, /could not be verified/);
		assert.equal(checked.writes(), 1);
	}
	const archive = {
		kind: "user",
		archive_format: "zip",
		archive_base64: "AAECAw==",
	};
	const archiveReceipt = {
		kind: "user",
		slug: personal.username,
		files_written: ["index.html"],
		archive_sha256: createHash("sha256")
			.update(Buffer.from(archive.archive_base64, "base64"))
			.digest("hex"),
		review_urls: {},
	};
	const correct = await execute(
		"upload_static_package",
		archive,
		archiveReceipt,
	);
	assert.deepEqual(await correct.result, archiveReceipt);
	const wrong = await execute("upload_static_package", archive, {
		...archiveReceipt,
		archive_sha256: "0".repeat(64),
	});
	await assert.rejects(wrong.result, /could not be verified/);
	assert.equal(wrong.writes(), 1);
});
