import type { OperationalEvent } from "@agent-infra/observability";
import { describe, expect, it, vi } from "vitest";
import { createPlatformHealthApp } from "../app.js";
import {
	type DirectoryRouteDependencies,
	registerDirectoryRoutes,
} from "./directory-routes.js";

const generatedClientV2 = await import(
	new URL(
		"../../../web/src/pilot/generated-v2/client/index.ts",
		import.meta.url,
	).href
);
const generatedSdkV2 = await import(
	new URL("../../../web/src/pilot/generated-v2/index.ts", import.meta.url).href
);

const employee = {
	schemaVersion: 1 as const,
	userId: "user-a",
	displayName: "Ada",
	accountStatus: "active" as const,
	organizationIds: ["org-a"],
	roles: ["employee" as const],
	authorizationRevision: "authorization-a",
};
const records = [
	{
		kind: "user" as const,
		canonicalId: "user-b",
		displayName: "林默",
		email: "lin@example.test",
		organizationPath: "研发 / 平台工程",
	},
	{
		kind: "user" as const,
		canonicalId: "user-c",
		displayName: "周可",
	},
];

function createApp(
	options: {
		identity?: () => Promise<unknown>;
		search?: DirectoryRouteDependencies["search"];
		events?: OperationalEvent[];
	} = {},
) {
	const events = options.events;
	// 使用生产的 Health App：其 onError 会把未映射的异常变成 500，用来证明本路由不会落到那里。
	const app = createPlatformHealthApp(
		events
			? ({
					record: (event: OperationalEvent) => events.push(event),
					status: () => ({}),
				} as unknown as Parameters<typeof createPlatformHealthApp>[0])
			: undefined,
	);
	const identity = {
		resolve: vi.fn(options.identity ?? (async () => employee)),
		hydrateUsers: vi.fn().mockResolvedValue([]),
	};
	const search = vi.fn(options.search ?? (async () => records));
	registerDirectoryRoutes(app, { identity, search });
	return { app, identity, search };
}

async function protocol(response: Response) {
	return (await response.json()) as {
		code: string;
		retryable: boolean;
		traceId: string;
	};
}

describe("GET /api/v2/directory/search (#3035)", () => {
	it("returns the existing response shape and passes only the validated query", async () => {
		const { app, search } = createApp();
		const response = await app.request(
			"/api/v2/directory/search?kind=user&q=%20%20%E6%9E%97%20&limit=50&ids=user-b,%20user-c%20,,",
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			items: records,
			query: "林",
			kind: "user",
		});
		expect(search).toHaveBeenCalledTimes(1);
		expect(search).toHaveBeenCalledWith({
			kind: "user",
			query: "林",
			ids: ["user-b", "user-c"],
			limit: 50,
		});
	});

	it("keeps the existing defaults for an omitted keyword and limit", async () => {
		const { app, search } = createApp({ search: async () => [] });
		const response = await app.request(
			"/api/v2/directory/search?kind=organization",
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			items: [],
			query: "",
			kind: "organization",
		});
		expect(search).toHaveBeenCalledWith({
			kind: "organization",
			query: "",
			ids: [],
			limit: 20,
		});
	});

	it("serves the generated V2 client with the contract response", async () => {
		const { app, search } = createApp();
		const client = generatedClientV2.createClient({
			baseUrl: "https://platform.example.test",
			fetch: async (input: string | URL | Request, init?: RequestInit) =>
				app.fetch(input instanceof Request ? input : new Request(input, init)),
		});
		const result = await generatedSdkV2.searchDirectoryV2({
			client,
			query: { kind: "user", q: "", limit: 50, ids: "user-b,user-c" },
		});
		expect(result.response.status).toBe(200);
		expect(result.data).toEqual({ items: records, query: "", kind: "user" });
		expect(search).toHaveBeenCalledWith({
			kind: "user",
			query: "",
			ids: ["user-b", "user-c"],
			limit: 50,
		});
	});

	it("drops undeclared fields returned by the deployment directory", async () => {
		const { app } = createApp({
			search: async () =>
				[
					{ ...records[0], phone: "PRIVATE_PHONE", ldapDn: "uid=user-b" },
				] as never,
		});
		const response = await app.request("/api/v2/directory/search?kind=user");
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(JSON.parse(text)).toEqual({
			items: [records[0]],
			query: "",
			kind: "user",
		});
		expect(text).not.toContain("PRIVATE_PHONE");
		expect(text).not.toContain("ldapDn");
	});

	it("requires a signed-in session before reading the directory", async () => {
		const { app, search } = createApp({ identity: async () => null });
		const response = await app.request("/api/v2/directory/search?kind=user");
		expect(response.status).toBe(401);
		expect(await protocol(response)).toMatchObject({
			code: "AUTHENTICATION_REQUIRED",
		});
		expect(search).not.toHaveBeenCalled();
	});

	it("refuses a disabled account", async () => {
		const { app, search } = createApp({
			identity: async () => ({ ...employee, accountStatus: "disabled" }),
		});
		const response = await app.request("/api/v2/directory/search?kind=user");
		expect(response.status).toBe(403);
		expect(await protocol(response)).toMatchObject({
			code: "AUTHORIZATION_REVOKED",
		});
		expect(search).not.toHaveBeenCalled();
	});

	it.each([
		["a missing kind", "q=a"],
		["an unknown kind", "kind=group"],
		["a keyword over 120 characters", `kind=user&q=${"x".repeat(121)}`],
		["a zero limit", "kind=user&limit=0"],
		["a limit over 50", "kind=user&limit=51"],
		["a non-numeric limit", "kind=user&limit=all"],
		[
			"more than 50 IDs",
			`kind=user&ids=${Array.from({ length: 51 }, (_, index) => `u${index}`).join(",")}`,
		],
		["a repeated parameter", "kind=user&kind=organization"],
		["an undeclared parameter", "kind=user&cursor=next"],
	])("rejects %s without reading the directory", async (_name, query) => {
		const { app, search } = createApp();
		const response = await app.request(`/api/v2/directory/search?${query}`);
		expect(response.status).toBe(400);
		expect(await protocol(response)).toMatchObject({
			code: "INVALID_REQUEST",
		});
		expect(search).not.toHaveBeenCalled();
	});

	it("does not let a caller choose another organization or user scope", async () => {
		// 组织 B 的员工提交组织 A 的范围字段：请求被拒绝，目录不按调用方字段读取。
		const otherOrganization = {
			...employee,
			userId: "user-b",
			organizationIds: ["org-b"],
		};
		const { app, search } = createApp({
			identity: async () => otherOrganization,
		});
		for (const query of [
			"kind=user&organizationId=org-a",
			"kind=user&organizationIds=org-a",
			"kind=user&userId=user-a",
		]) {
			const response = await app.request(`/api/v2/directory/search?${query}`);
			expect(response.status).toBe(400);
		}
		expect(search).not.toHaveBeenCalled();
		// 伪造的身份或组织请求头不进入目录读取；读取输入只有校验后的查询字段。
		const response = await app.request("/api/v2/directory/search?kind=user", {
			headers: {
				"X-Platform-User-Id": "user-a",
				"X-Organization-Id": "org-a",
			},
		});
		expect(response.status).toBe(200);
		expect(search).toHaveBeenCalledTimes(1);
		expect(search.mock.calls[0]?.[0]).toEqual({
			kind: "user",
			query: "",
			ids: [],
			limit: 20,
		});
	});

	it("maps an identity dependency failure to the contract 503", async () => {
		const { app, search } = createApp({
			identity: async () => {
				throw new Error("PRIVATE_LDAP_DETAIL");
			},
		});
		const response = await app.request("/api/v2/directory/search?kind=user");
		expect(response.status).toBe(503);
		const text = await response.text();
		expect(JSON.parse(text)).toMatchObject({
			code: "DEPENDENCY_UNAVAILABLE",
			retryable: true,
		});
		expect(text).not.toContain("PRIVATE_LDAP_DETAIL");
		expect(search).not.toHaveBeenCalled();
	});

	it("maps a directory failure to the contract 503 instead of an undeclared 500", async () => {
		const { app } = createApp({
			search: async () => {
				throw new TypeError("PRIVATE_DIRECTORY_MEMBER lin@example.test");
			},
		});
		const response = await app.request("/api/v2/directory/search?kind=user");
		expect(response.status).toBe(503);
		const text = await response.text();
		expect(JSON.parse(text)).toMatchObject({
			schemaVersion: 1,
			code: "DEPENDENCY_UNAVAILABLE",
			retryable: true,
		});
		expect(text).not.toContain("PRIVATE_DIRECTORY_MEMBER");
		expect(text).not.toContain("example.test");
	});

	it.each([
		["a non-array result", { items: records }],
		[
			"a record without a canonical ID",
			[{ kind: "user", displayName: "林默" }],
		],
		["an empty canonical ID", [{ ...records[0], canonicalId: "" }]],
		["a non-string display name", [{ ...records[0], displayName: 1 }]],
		["a null email", [{ ...records[0], email: null }]],
		["an unknown record kind", [{ ...records[0], kind: "group" }]],
		["a non-object record", ["user-b"]],
	])("maps %s from the directory to the contract 503", async (_name, value) => {
		const { app } = createApp({ search: async () => value as never });
		const response = await app.request("/api/v2/directory/search?kind=user");
		expect(response.status).toBe(503);
		expect(await protocol(response)).toMatchObject({
			code: "DEPENDENCY_UNAVAILABLE",
		});
	});

	it("records the bounded directory.search step without private details", async () => {
		const events: OperationalEvent[] = [];
		const { app } = createApp({
			events,
			search: async () => {
				throw new TypeError("PRIVATE_DIRECTORY_MEMBER lin@example.test");
			},
		});
		const response = await app.request(
			"/api/v2/directory/search?kind=user&q=PRIVATE_QUERY",
		);
		expect(response.status).toBe(503);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			outcome: "failed",
			status: 503,
			protocolCode: "DEPENDENCY_UNAVAILABLE",
			failureStep: "directory.search",
			errorClass: "TypeError",
		});
		const recorded = JSON.stringify(events);
		expect(recorded).not.toContain("PRIVATE_DIRECTORY_MEMBER");
		expect(recorded).not.toContain("example.test");
		expect(recorded).not.toContain("PRIVATE_QUERY");
	});
});
