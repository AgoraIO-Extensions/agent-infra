import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { staticSpacesV6ExecutorDigest } from "./static-spaces-v6-integrity.ts";
import {
	staticSpacesConnectionCatalog as catalog,
	StaticSpacesAdapter,
} from "./static-spaces-v7.ts";

const token = "synthetic-test-token-only";
const sha = "a".repeat(64);
const invoke = (name: string, input: Record<string, unknown>) => ({
	action: `static-spaces.${name}`,
	actionVersionId: `static-spaces.${name}@v7`,
	providerId: "static-spaces",
	providerReleaseId: catalog.providerReleaseId,
	credential: { accessToken: token },
	input,
});
const principal = (admin = false) => ({
	user: {
		pk: 951,
		username: "owner@example.invalid",
		is_active: true,
		is_superuser: admin,
	},
});
const scope = {
	kind: "shared",
	slug: "team",
	path_prefix: "/spaces/shared/team/",
	url_prefix: "https://static-spaces.sh3.agoralab.co/spaces/shared/team/",
};
const member = {
	username: "bob",
	group: "static-spaces-shared-team-viewers",
	member: true,
};
const comment = {
	id: "comment-1",
	author_email: "owner@example.invalid",
	body: "review",
	created_at: "2026-10-12T01:00:00Z",
	edited_at: null,
	deleted_at: null,
	can_edit: true,
	can_delete: true,
};
const thread = {
	id: "thread-1",
	anchor: { type: "document", document_sha256: sha },
	comments: [comment],
};
const review = {
	document: {
		kind: "shared",
		slug: "team",
		path: "note.md",
		content: "# note",
		size: 6,
		sha256: sha,
		raw_url: "https://static-spaces.sh3.agoralab.co/spaces/shared/team/note.md",
		review_url:
			"https://static-spaces.sh3.agoralab.co/spaces/shared/team/note.md?view=review",
	},
	comments: {
		etag: "etag",
		updated_at: null,
		thread_count: 1,
		threads: [thread],
	},
};
const group = { pk: "group-1", name: "directory-1", is_superuser: false };
const directory = {
	pk: "group-1",
	name: "directory-1",
	display_name: "Team",
	path: "R&D/Team",
	member_count: 5,
	directory_uid: "1",
};
const acl = {
	prefix: scope.path_prefix,
	groups: [member.group, "directory-1"],
	enabled: true,
};
const removed = { deleted: true };
const doc = { kind: "shared", slug: "team", path: "note.md" };
const cases: [
	string,
	Record<string, unknown>,
	Record<string, unknown>,
	string,
	string,
][] = [
	[
		"search_directory_groups",
		{ query: "Team", limit: 10 },
		{ groups: [directory] },
		"GET",
		"/v1/directory-groups",
	],
	[
		"manage_shared_membership",
		{
			kind: "shared",
			slug: "team",
			username: "bob",
			role: "viewer",
			action: "add",
		},
		member,
		"POST",
		"/v1/shared-memberships",
	],
	[
		"manage_shared_group_grant",
		{
			kind: "shared",
			slug: "team",
			group: "directory-1",
			role: "viewer",
			action: "add",
		},
		{
			...scope,
			role: "viewer",
			action: "add",
			group: directory,
			application: { pk: "app", slug: "static-spaces-shared-team" },
			acl,
			acl_groups: acl.groups,
			application_binding: {
				pk: "binding",
				target: "app",
				group: "group-1",
				enabled: true,
				negate: false,
			},
		},
		"POST",
		"/v1/shared-group-grants",
	],
	[
		"delete_file",
		{ kind: "shared", slug: "team", relative_path: "note.md" },
		{
			...scope,
			deleted: true,
			path: "/spaces/shared/team/note.md",
			comments_deleted: 1,
		},
		"POST",
		"/v1/delete-file",
	],
	[
		"delete_space",
		{ kind: "shared", slug: "team" },
		{
			...scope,
			acl: { ...removed, prefix: scope.path_prefix },
			directory: { ...removed, path_prefix: scope.path_prefix },
			comments_deleted: 1,
			application: { ...removed, slug: "static-spaces-shared-team" },
			groups: ["owners", "managers", "viewers"].map((role) => ({
				...removed,
				name: `static-spaces-shared-team-${role}`,
			})),
		},
		"POST",
		"/v1/delete-space",
	],
	[
		"render_index",
		{ kind: "shared", slug: "team" },
		{
			...scope,
			path: "/spaces/shared/team/index.html",
			url: "https://static-spaces.sh3.agoralab.co/spaces/shared/team/index.html",
			size: 10,
			sha256: sha,
		},
		"POST",
		"/v1/render-index",
	],
	[
		"create_markdown_comment",
		{
			...doc,
			body: "review",
			document_sha256: sha,
			anchor: { type: "document" },
		},
		{ etag: "etag", thread },
		"POST",
		"/v1/markdown-review/comments",
	],
	[
		"edit_markdown_comment",
		{ ...doc, comment_id: "comment-1", body: "review" },
		{ etag: "etag", comment },
		"PATCH",
		"/v1/markdown-review/comments/comment-1",
	],
	[
		"delete_markdown_comment",
		{ ...doc, comment_id: "comment-1" },
		{
			etag: "etag",
			deleted: true,
			comment_id: "comment-1",
			thread_id: "thread-1",
		},
		"DELETE",
		"/v1/markdown-review/comments/comment-1",
	],
	[
		"admin_find_users",
		{ username: "bob" },
		{ users: [{ pk: 2, username: "bob" }] },
		"GET",
		"/v1/users",
	],
	[
		"admin_find_groups",
		{ name: "directory-1" },
		{ groups: [group] },
		"GET",
		"/v1/groups",
	],
	[
		"admin_list_acl",
		{ prefix: scope.path_prefix },
		{ rules: [acl] },
		"GET",
		"/v1/acl",
	],
	[
		"admin_ensure_group",
		{ name: "directory-1" },
		{ created: false, group },
		"POST",
		"/v1/groups",
	],
	[
		"admin_manage_membership",
		{ username: "bob", group: member.group, action: "add" },
		member,
		"POST",
		"/v1/memberships",
	],
	[
		"admin_set_acl",
		{ prefix: scope.path_prefix, groups: acl.groups, enabled: true },
		acl,
		"POST",
		"/v1/acl",
	],
	[
		"admin_check_access",
		{ username: "bob", path: "/spaces/shared/team/note.md" },
		{
			username: "bob",
			path: "/spaces/shared/team/note.md",
			allowed: false,
			status: 403,
		},
		"POST",
		"/v1/check-access",
	],
	[
		"admin_ensure_internal_user",
		{ username: "bob" },
		{
			created: true,
			user: { pk: 2, username: "bob", active: true },
			temporary_password: "must-not-escape",
		},
		"POST",
		"/v1/users",
	],
];
test("v7 has unified 24 actions, READ classification and transitive immutable digest", () => {
	assert.equal(catalog.actions.length, 24);
	assert.equal(new Set(catalog.actions.map((a) => a.name)).size, 24);
	assert.equal(
		catalog.actions.find((a) => a.name.endsWith("admin_check_access"))?.effect,
		"READ",
	);
	const sum = createHash("sha256")
		.update(readFileSync(new URL("./static-spaces-v7.ts", import.meta.url)))
		.update(
			readFileSync(new URL("./static-spaces-v7-actions.ts", import.meta.url)),
		)
		.update(staticSpacesV6ExecutorDigest)
		.digest("hex");
	assert.equal(catalog.executorDigest, `sha256:${sum}`);
});
for (const [name, input, result, method, path] of cases)
	test(`${name}: fixed method/route and schema-projected output`, async () => {
		let submissions = 0;
		const adapter = new StaticSpacesAdapter(async (url, init) => {
			const u = new URL(String(url));
			if (u.pathname.endsWith("/users/me/"))
				return Response.json(principal(true));
			if (u.pathname === "/v1/markdown-review") return Response.json(review);
			submissions++;
			assert.equal(u.origin, "https://publish-static-spaces.sh3.agoralab.co");
			assert.equal(u.pathname, path);
			assert.equal(init?.method, method);
			assert.equal(init?.redirect, "manual");
			const body = init?.body ? JSON.parse(String(init.body)) : {};
			if (name === "render_index") assert.equal(body.overwrite, false);
			if (name === "admin_ensure_internal_user") {
				assert.equal(body.generate_password, false);
				assert.equal(body.return_password, false);
				assert.equal(body.temporary_password, undefined);
			}
			return Response.json({ ...result, internal_secret: "never-persist" });
		});
		assert.equal(
			(await adapter.validateCredential(token)).externalAccount,
			"951",
		);
		const output = await adapter.execute(invoke(name, input));
		assert.equal(submissions, 1);
		assert.ok(!JSON.stringify(output).includes("never-persist"));
		assert.ok(!JSON.stringify(output).includes("must-not-escape"));
	});
test("all admin actions reject non-admin before any upstream submission", async () => {
	for (const [name, input] of cases.filter((c) => c[0].startsWith("admin_"))) {
		let count = 0;
		const adapter = new StaticSpacesAdapter(async (url) => {
			if (String(url).includes("/users/me/")) return Response.json(principal());
			count++;
			throw new Error("unexpected");
		});
		await assert.rejects(adapter.execute(invoke(name, input)), {
			providerStatus: 403,
		});
		assert.equal(count, 0);
	}
});
test("untrusted identity, role, passwords, root ACL, unsafe path and reply anchors rejected", async () => {
	const adapter = new StaticSpacesAdapter(async () =>
		Response.json(principal(true)),
	);
	for (const [name, input] of [
		["admin_set_acl", { prefix: "/spaces/", groups: [], enabled: true }],
		[
			"delete_file",
			{ kind: "shared", slug: "team", relative_path: "../other/note.md" },
		],
		[
			"admin_ensure_internal_user",
			{ username: "bob", generate_password: true },
		],
		[
			"admin_ensure_internal_user",
			{ username: "bob", temporary_password: "secret" },
		],
		[
			"manage_shared_membership",
			{
				kind: "shared",
				slug: "team",
				emails: ["bob@example.invalid"],
				role: "owner",
				action: "add",
			},
		],
		[
			"manage_shared_membership",
			{
				kind: "shared",
				slug: "team",
				username: "bob",
				emails: ["bob@example.invalid"],
				role: "viewer",
				action: "add",
			},
		],
		[
			"create_markdown_comment",
			{
				...doc,
				body: "review",
				thread_id: "thread-1",
				anchor: { type: "document" },
			},
		],
		["delete_space", { kind: "shared", slug: "team", is_admin: true }],
	] as [string, Record<string, unknown>][])
		await assert.rejects(adapter.execute(invoke(name, input)), {
			providerStatus: 400,
		});
});
test("cross-author edits/deletes denied before mutation, ordinary role failures don't invalidate token", async () => {
	for (const name of ["edit_markdown_comment", "delete_markdown_comment"]) {
		let writes = 0;
		const adapter = new StaticSpacesAdapter(async (url, init) => {
			if (String(url).includes("/users/me/")) return Response.json(principal());
			if (init?.method === "GET")
				return Response.json({
					...review,
					comments: {
						...review.comments,
						threads: [
							{
								...thread,
								comments: [{ ...comment, can_edit: false, can_delete: false }],
							},
						],
					},
				});
			writes++;
			throw new Error("unexpected");
		});
		await assert.rejects(
			adapter.execute(
				invoke(name, {
					...doc,
					comment_id: "comment-1",
					...(name.startsWith("edit") ? { body: "review" } : {}),
				}),
			),
			{ providerStatus: 403 },
		);
		assert.equal(writes, 0);
	}
	let posts = 0;
	const adapter = new StaticSpacesAdapter(async (url) => {
		if (String(url).includes("/users/me/")) return Response.json(principal());
		posts++;
		return new Response(null, { status: 403 });
	});
	await assert.rejects(
		adapter.execute(
			invoke("manage_shared_membership", {
				kind: "shared",
				slug: "team",
				username: "bob",
				role: "owner",
				action: "remove",
			}),
		),
		(e: unknown) =>
			Boolean(
				e &&
					typeof e === "object" &&
					"providerStatus" in e &&
					e.providerStatus === 403 &&
					!("providerCredentialInvalid" in e && e.providerCredentialInvalid),
			),
	);
	assert.equal(posts, 1);
});
test("DELETE response loss submits once; admin access-check loss is not mutating", async () => {
	for (const [name, input] of [
		["delete_markdown_comment", { ...doc, comment_id: "comment-1" }],
		[
			"admin_check_access",
			{ username: "bob", path: "/spaces/shared/team/note.md" },
		],
	] as [string, Record<string, unknown>][]) {
		let count = 0;
		const adapter = new StaticSpacesAdapter(async (url) => {
			if (String(url).includes("/users/me/"))
				return Response.json(principal(true));
			if (String(url).includes("/v1/markdown-review?"))
				return Response.json(review);
			count++;
			throw new Error("response-lost");
		});
		await assert.rejects(adapter.execute(invoke(name, input)), {
			submissionUncertain: name !== "admin_check_access",
		});
		assert.equal(count, 1);
	}
});
test("ordinary personal write cannot target a different user", async () => {
	let writes = 0;
	const adapter = new StaticSpacesAdapter(async (url) => {
		if (String(url).includes("/users/me/")) return Response.json(principal());
		writes++;
		throw new Error("unexpected");
	});
	await assert.rejects(
		adapter.execute(
			invoke("delete_space", {
				kind: "user",
				username: "other@example.invalid",
			}),
		),
		{ providerStatus: 403 },
	);
	assert.equal(writes, 0);
});

test("mismatched destructive and sharing receipts never become success", async () => {
	const mutations: [string, Record<string, unknown>][] = [
		["delete_file", { path: "/spaces/shared/team/another.md" }],
		["render_index", { url: "https://other.invalid/index.html" }],
		[
			"delete_space",
			{ acl: { deleted: true, prefix: "/spaces/shared/other/" } },
		],
		[
			"manage_shared_group_grant",
			{ acl: { ...acl, prefix: "/spaces/shared/other/" } },
		],
		[
			"manage_shared_group_grant",
			{
				application_binding: {
					pk: "b",
					target: "app",
					group: "g",
					enabled: true,
					negate: true,
				},
			},
		],
	];
	for (const [name, changed] of mutations) {
		const entry = cases.find((c) => c[0] === name);
		if (!entry) throw new Error("missing fixture");
		let writes = 0;
		const adapter = new StaticSpacesAdapter(async (url) => {
			if (String(url).includes("/users/me/")) return Response.json(principal());
			writes++;
			return Response.json({ ...entry[2], ...changed });
		});
		await assert.rejects(adapter.execute(invoke(name, entry[1])));
		assert.equal(writes, 1);
	}
});
test("DOCUMENT_CHANGED is preserved without returning upstream text or replaying", async () => {
	let writes = 0;
	const adapter = new StaticSpacesAdapter(async (url) => {
		if (String(url).includes("/users/me/")) return Response.json(principal());
		writes++;
		return Response.json(
			{
				error: {
					code: "DOCUMENT_CHANGED",
					message: "must-not-leak-comment-body",
				},
			},
			{ status: 409 },
		);
	});
	await assert.rejects(
		adapter.execute(
			invoke("create_markdown_comment", {
				...doc,
				body: "review",
				document_sha256: sha,
				anchor: { type: "document" },
			}),
		),
		(e: unknown) =>
			Boolean(
				e &&
					typeof e === "object" &&
					"providerCode" in e &&
					e.providerCode === "DOCUMENT_CHANGED" &&
					!String(e).includes("must-not-leak"),
			),
	);
	assert.equal(writes, 1);
});
test("manager owner change and last-owner refusal preserve upstream denial", async () => {
	for (const [role, action] of [
		["owner", "add"],
		["owner", "remove"],
	]) {
		let posts = 0;
		const adapter = new StaticSpacesAdapter(async (url) => {
			if (String(url).includes("/users/me/")) return Response.json(principal());
			posts++;
			return Response.json(
				{ error: { code: "FORBIDDEN", message: "role denied" } },
				{ status: 403 },
			);
		});
		await assert.rejects(
			adapter.execute(
				invoke("manage_shared_membership", {
					kind: "shared",
					slug: "team",
					username: "bob",
					role,
					action,
				}),
			),
			{ providerCode: "FORBIDDEN", providerStatus: 403 },
		);
		assert.equal(posts, 1);
	}
});
test("directory groups cannot grant writer roles", async () => {
	const adapter = new StaticSpacesAdapter(async () => {
		throw new Error("should not submit");
	});
	for (const role of ["owner", "manager"])
		await assert.rejects(
			adapter.execute(
				invoke("manage_shared_group_grant", {
					kind: "shared",
					slug: "team",
					group: "directory-1",
					role,
					action: "add",
				}),
			),
			{ providerStatus: 400 },
		);
});

test("delete-space refuses a receipt for another shared portal application", async () => {
	const entry = cases.find((c) => c[0] === "delete_space");
	if (!entry) throw new Error("missing fixture");
	const adapter = new StaticSpacesAdapter(async (url) =>
		String(url).includes("/users/me/")
			? Response.json(principal())
			: Response.json({
					...entry[2],
					application: { deleted: true, slug: "static-spaces-shared-other" },
				}),
	);
	await assert.rejects(adapter.execute(invoke("delete_space", entry[1])));
});

test("admin publishing accepts precise content receipts without inventing creator membership", async () => {
	const username = "other@example.invalid";
	const content = "test";
	const prefix = `/spaces/users/${username}/`;
	const path = `${prefix}note.txt`;
	const receipt = {
		kind: "user",
		slug: username,
		path_prefix: prefix,
		url_prefix: `https://static-spaces.sh3.agoralab.co${prefix}`,
		group: {
			created: true,
			group: {
				pk: "g",
				name: `static-spaces-users-${username}-viewers`,
				is_superuser: false,
			},
		},
		acl: {
			prefix,
			groups: [`static-spaces-users-${username}-viewers`],
			enabled: true,
		},
		files_written: [
			{
				kind: "user",
				slug: username,
				path,
				url: `https://static-spaces.sh3.agoralab.co${path}`,
				size: 4,
				sha256: createHash("sha256").update(content).digest("hex"),
			},
		],
		review_urls: {},
		memberships: [],
		verification: [],
	};
	const adapter = new StaticSpacesAdapter(async (url) =>
		String(url).includes("/users/me/")
			? Response.json(principal(true))
			: Response.json(receipt),
	);
	const result = await adapter.execute(
		invoke("publish_space", {
			kind: "user",
			username,
			files: [{ relative_path: "note.txt", content }],
		}),
	);
	assert.deepEqual(result.memberships, []);
});
test("normal first publication still requires creator membership and read verification", async () => {
	const username = "owner@example.invalid";
	const prefix = `/spaces/users/${username}/`;
	const content = "test";
	const path = `${prefix}note.txt`;
	const receipt = {
		kind: "user",
		slug: username,
		path_prefix: prefix,
		url_prefix: `https://static-spaces.sh3.agoralab.co${prefix}`,
		group: {
			created: true,
			group: {
				pk: "g",
				name: `static-spaces-users-${username}-viewers`,
				is_superuser: false,
			},
		},
		acl: {
			prefix,
			groups: [`static-spaces-users-${username}-viewers`],
			enabled: true,
		},
		files_written: [
			{
				kind: "user",
				slug: username,
				path,
				url: `https://static-spaces.sh3.agoralab.co${path}`,
				size: 4,
				sha256: createHash("sha256").update(content).digest("hex"),
			},
		],
		review_urls: {},
		memberships: [],
		verification: [],
	};
	const adapter = new StaticSpacesAdapter(async (url) =>
		String(url).includes("/users/me/")
			? Response.json(principal())
			: Response.json(receipt),
	);
	await assert.rejects(
		adapter.execute(
			invoke("publish_space", {
				kind: "user",
				files: [{ relative_path: "note.txt", content }],
			}),
		),
	);
});

test("all namespace roots are rejected before identity or ACL submission", async () => {
	let calls = 0;
	const adapter = new StaticSpacesAdapter(async () => {
		calls++;
		throw new Error("must not submit");
	});
	for (const prefix of [
		"/spaces/",
		"/spaces/users/",
		"/spaces/shared/",
		"/spaces/public/",
	]) {
		await assert.rejects(
			adapter.execute(
				invoke("admin_set_acl", { prefix, groups: [], enabled: true }),
			),
			{ providerStatus: 400 },
		);
		await assert.rejects(
			adapter.execute(invoke("admin_list_acl", { prefix })),
			{ providerStatus: 400 },
		);
	}
	assert.equal(calls, 0);
});

test("file-level ACL is rejected rather than silently changed to a directory", async () => {
	let calls = 0;
	const adapter = new StaticSpacesAdapter(async () => {
		calls++;
		throw new Error("must not submit");
	});
	await assert.rejects(
		adapter.execute(
			invoke("admin_set_acl", {
				prefix: "/spaces/shared/team/note.md",
				groups: [],
				enabled: true,
			}),
		),
		{ providerStatus: 400 },
	);
	assert.equal(calls, 0);
});

test("directory grant binds group, application and slug references before success", async () => {
	const entry = cases.find((c) => c[0] === "manage_shared_group_grant");
	if (!entry) throw new Error("missing fixture");
	const original = entry[2];
	const binding = original.application_binding as Record<string, unknown>;
	const mismatches = [
		{
			...original,
			application_binding: { ...binding, group: "another-group" },
		},
		{
			...original,
			application_binding: { ...binding, target: "another-portal" },
		},
		{
			...original,
			application: { pk: "app", slug: "static-spaces-shared-other" },
		},
		{ ...original, application: null },
		{ ...original, group: { ...directory, pk: undefined } },
	];
	for (const result of mismatches) {
		let posts = 0;
		const adapter = new StaticSpacesAdapter(async (url) => {
			if (String(url).includes("/users/me/")) return Response.json(principal());
			posts++;
			return Response.json(result);
		});
		await assert.rejects(adapter.execute(invoke(entry[0], entry[1])));
		assert.equal(posts, 1);
	}
});
test("directory grant remove supports an absent portal without recreating it", async () => {
	const input = {
		kind: "shared",
		slug: "team",
		group: "directory-1",
		role: "viewer",
		action: "remove",
	};
	const viewer = "static-spaces-shared-team-viewers";
	const result = {
		...scope,
		role: "viewer",
		action: "remove",
		group: directory,
		application: null,
		acl: { prefix: scope.path_prefix, groups: [viewer], enabled: true },
		acl_groups: [viewer],
		application_binding: {
			deleted: false,
			group: "directory-1",
			reason: "application_not_found",
		},
	};
	let posts = 0;
	const adapter = new StaticSpacesAdapter(async (url) => {
		if (String(url).includes("/users/me/")) return Response.json(principal());
		posts++;
		return Response.json(result);
	});
	assert.equal(
		(await adapter.execute(invoke("manage_shared_group_grant", input)))
			.application,
		null,
	);
	assert.equal(posts, 1);
});
