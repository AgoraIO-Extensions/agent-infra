import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type AuthentikDirectoryConfiguration,
	createAuthentikDirectory,
} from "../../deploy/local/authentik/directory.ts";

function at<T>(values: readonly T[], index: number): T {
	const value = values[index];
	assert(value !== undefined);
	return value;
}

const employee = "11111111-1111-4111-8111-111111111111";
const admin = "22222222-2222-4222-8222-222222222222";
const organization = "33333333-3333-4333-8333-333333333333";
const config: AuthentikDirectoryConfiguration = {
	origin: "https://identity.example.test",
	issuer: "https://identity.example.test/application/o/platform/",
	instanceNamespace: "dedicated-instance",
	apiToken: "synthetic-directory-test-token",
	roleGroups: { employee: [employee], system_admin: [admin] },
	organizationGroups: [{ groupId: organization, organizationId: "org-one" }],
};
const alice = {
	pk: 12,
	uid: "opaque-alice",
	username: "alice",
	name: "Alice",
	is_active: true,
	is_superuser: true,
	groups: [employee, organization],
};
const bob = {
	pk: 13,
	uid: "opaque-bob",
	username: "bob",
	name: "Bob",
	is_active: true,
	is_superuser: false,
	groups: [employee, admin],
};
function fixture() {
	const state = {
		users: [structuredClone(alice), structuredClone(bob)],
		groups: [employee, admin, organization],
		failPage: 0,
		malformed: false,
		duplicate: false,
		redirect: false,
		calls: [] as string[],
	};
	const transport: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		assert.equal(url.origin, config.origin);
		assert.equal(init?.redirect, "error");
		assert.equal(
			new Headers(init?.headers).get("authorization"),
			`Bearer ${config.apiToken}`,
		);
		assert(init?.signal);
		state.calls.push(url.href);
		if (state.redirect)
			return new Response(null, {
				status: 302,
				headers: { location: "https://evil.example.test" },
			});
		const page = Number(url.searchParams.get("page"));
		if (state.failPage === page)
			throw new Error(`Do not expose ${config.apiToken}`);
		const all = url.pathname.endsWith("/users/")
			? state.users
			: state.groups.map((pk) => ({ pk }));
		const results = all.slice(page - 1, page);
		if (state.duplicate && url.pathname.endsWith("/users/") && page === 2)
			results[0] = at(state.users, 0);
		return Response.json({
			pagination: {
				count: all.length,
				total_pages: Math.max(1, all.length),
				current: page,
				next: page < all.length ? page + 1 : 0,
				previous: page === 1 ? 0 : page - 1,
				start_index: all.length ? page : 0,
				end_index: all.length ? page : 0,
			},
			results: state.malformed ? [{}] : results,
		});
	};
	return {
		state,
		directory: createAuthentikDirectory(config, transport),
		transport,
	};
}

test("verified uid binding separates users, instances and REST pk; superuser never becomes Platform admin", async () => {
	const { directory, transport } = fixture();
	const a = await directory.resolveVerifiedSubject({
		issuer: config.issuer,
		subject: alice.uid,
	});
	const b = await directory.resolveVerifiedSubject({
		issuer: config.issuer,
		subject: bob.uid,
	});
	assert(a && b);
	assert.notEqual(a.userId, b.userId);
	assert.match(a.userId, /^authentik_[0-9a-f]{64}$/u);
	assert.deepEqual(a.roles, ["employee"]);
	assert.deepEqual(a.organizationIds, ["org-one"]);
	assert.deepEqual(b.roles, ["employee", "system_admin"]);
	assert.equal(
		await directory.resolveVerifiedSubject({
			issuer: config.issuer,
			subject: "12",
		}),
		null,
	);
	assert.equal(
		await directory.resolveVerifiedSubject({
			issuer: "https://wrong.example.test",
			subject: alice.uid,
		}),
		null,
	);
	const other = createAuthentikDirectory(
		{ ...config, instanceNamespace: "other" },
		transport,
	);
	assert.equal(await other.resolveIdentity(a.userId), null);
	assert.equal((await directory.resolveUser(a.userId))?.userId, a.userId);
	assert.deepEqual(
		(await directory.hydrateUsers([b.userId, a.userId])).map(
			(user) => user.displayName,
		),
		["Bob", "Alice"],
	);
});

test("fresh group and account changes revoke access and change authorization revision", async () => {
	const { directory, state } = fixture();
	const initial = await directory.resolveVerifiedSubject({
		issuer: config.issuer,
		subject: alice.uid,
	});
	assert(initial);
	at(state.users, 0).groups = [employee];
	const removed = await directory.resolveIdentity(initial.userId);
	assert(removed);
	assert.deepEqual(removed.organizationIds, []);
	assert.notEqual(removed.authorizationRevision, initial.authorizationRevision);
	at(state.users, 0).name = "Renamed";
	assert.equal(
		(await directory.resolveIdentity(initial.userId))?.authorizationRevision,
		removed.authorizationRevision,
	);
	at(state.users, 0).is_active = false;
	assert.equal(await directory.resolveIdentity(initial.userId), null);
	assert.equal(
		(await directory.resolveUser(initial.userId))?.accountStatus,
		"disabled",
	);
	state.users.splice(0, 1);
	assert.equal(await directory.resolveUser(initial.userId), null);
	await assert.rejects(
		directory.hydrateUsers([initial.userId]),
		/AUTHENTIK_DIRECTORY_UNAVAILABLE/u,
	);
});

test("pk reuse or uid changes cannot inherit old business references", async () => {
	const { directory, state } = fixture();
	const initial = await directory.resolveVerifiedSubject({
		issuer: config.issuer,
		subject: alice.uid,
	});
	assert(initial);
	at(state.users, 0).uid = "replacement-user";
	assert.equal(await directory.resolveIdentity(initial.userId), null);
});

test("complete pagination yields authority, disabled and unmapped users remain non-authorizing", async () => {
	const { directory, state } = fixture();
	at(state.users, 0).groups = [];
	const authority = await directory.loadAuthorityContext();
	assert.equal(authority.users.length, 2);
	assert.equal(at(authority.users, 0).accountStatus, "disabled");
	assert.deepEqual(authority.organizationIds, ["org-one"]);
	assert.equal(
		await directory.resolveVerifiedSubject({
			issuer: config.issuer,
			subject: alice.uid,
		}),
		null,
	);
	assert(state.calls.some((url) => url.includes("page=3")));
});

for (const scenario of [
	"malformed",
	"duplicate",
	"redirect",
	"partial",
	"missing-group",
	"unknown-group",
	"duplicate-uid",
] as const) {
	test(`fails closed on ${scenario}, without upstream messages or tokens`, async () => {
		const { directory, state } = fixture();
		if (scenario === "partial") state.failPage = 2;
		else if (scenario === "missing-group") state.groups.pop();
		else if (scenario === "unknown-group")
			at(state.users, 0).groups.push("44444444-4444-4444-8444-444444444444");
		else if (scenario === "duplicate-uid") at(state.users, 1).uid = alice.uid;
		else state[scenario] = true;
		await assert.rejects(
			directory.loadAuthorityContext(),
			(error: Error) =>
				error.message === "AUTHENTIK_DIRECTORY_UNAVAILABLE" &&
				error.cause === undefined,
		);
	});
}

test("timeout aborts upstream calls; credentials never sent to arbitrary or insecure origins", async () => {
	const transport: typeof fetch = async (_input, init) =>
		new Promise((_resolve, reject) => {
			init?.signal?.addEventListener(
				"abort",
				() => reject(new Error("private upstream detail")),
				{ once: true },
			);
		});
	const timer = setTimeout(() => {}, 1000);
	try {
		await assert.rejects(
			createAuthentikDirectory(
				{ ...config, timeoutMs: 10 },
				transport,
			).loadAuthorityContext(),
			/AUTHENTIK_DIRECTORY_UNAVAILABLE/u,
		);
	} finally {
		clearTimeout(timer);
	}
	for (const origin of [
		"http://identity.example.test",
		"https://identity.example.test/path",
		"https://user:password@identity.example.test",
	])
		assert.throws(
			() => createAuthentikDirectory({ ...config, origin }),
			/AUTHENTIK_DIRECTORY_UNAVAILABLE/u,
		);
});

for (const change of [
	"next-url",
	"short-count",
	"page-change",
	"oversized",
	"http-failure",
] as const) {
	test(`rejects ${change} before using a partial directory`, async () => {
		const { transport } = fixture();
		const altered: typeof fetch = async (input, init) => {
			const response = await transport(input, init);
			if (change === "http-failure")
				return new Response("private detail", { status: 403 });
			if (change === "oversized")
				return new Response(" ".repeat(2 * 1024 * 1024 + 1));
			const body: unknown = await response.json();
			assert(body !== null && typeof body === "object" && "pagination" in body);
			const pagination = body.pagination;
			assert(pagination !== null && typeof pagination === "object");
			assert(
				"next" in pagination &&
					"count" in pagination &&
					"current" in pagination,
			);
			if (change === "next-url") pagination.next = "https://evil.example.test/";
			if (change === "short-count") pagination.count = 99;
			if (change === "page-change") pagination.current = 99;
			return Response.json(body);
		};
		await assert.rejects(
			createAuthentikDirectory(config, altered).loadAuthorityContext(),
			/AUTHENTIK_DIRECTORY_UNAVAILABLE/u,
		);
	});
}
