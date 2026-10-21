import {
	observabilityOpenApiPathsV1,
	PilotProtocolErrorV1Schema,
} from "@agent-infra/contracts/pilot";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createPlatformHealthApp } from "../app.js";
import { HttpProtocolError } from "./common.js";
import { registerObservabilityRoutes } from "./observability-routes.js";

const generatedClient = await import(
	new URL("../../../web/src/pilot/generated/client/index.ts", import.meta.url)
		.href
);
const generatedSdk = await import(
	new URL("../../../web/src/pilot/generated/index.ts", import.meta.url).href
);

const admin = {
	schemaVersion: 1 as const,
	userId: "admin-1",
	displayName: "Ada",
	accountStatus: "active" as const,
	organizationIds: ["org-1"],
	roles: ["employee" as const, "system_admin" as const],
	authorizationRevision: "rev-1",
};

function createApp(identity = admin, observability = true) {
	const app = new Hono();
	app.onError((error, context) =>
		error instanceof HttpProtocolError
			? context.json(error.body, error.status)
			: context.json({ error: "internal" }, 500),
	);
	const identityAdapter = {
		resolve: vi.fn().mockResolvedValue(identity),
		hydrateUsers: vi.fn().mockResolvedValue([]),
	};
	registerObservabilityRoutes(app, {
		identity: identityAdapter,
		...(observability
			? {
					observability: {
						status: () => ({
							enabled: true,
							state: "active" as const,
							captureFailures: 0,
							exportFailures: 2,
							droppedLogs: 1,
							invalidRecords: 0,
							lastExportFailureAt: "2026-10-13T00:00:00.000Z",
						}),
					},
				}
			: {}),
	});
	return { app, identityAdapter };
}

describe("observability status route", () => {
	it("returns only the redacted process status to a system administrator", async () => {
		const { app } = createApp();
		const response = await app.request("/api/v1/ops/observability");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			schemaVersion: 1,
			service: "platform-api",
			enabled: true,
			state: "active",
			captureFailures: 0,
			exportFailures: 2,
			droppedLogs: 1,
			invalidRecords: 0,
			lastExportFailureAt: "2026-10-13T00:00:00.000Z",
		});
	});

	it("denies ordinary users and does not expose status fields", async () => {
		const { app } = createApp({ ...admin, roles: ["employee"] });
		const response = await app.request("/api/v1/ops/observability");
		expect(response.status).toBe(403);
		expect(JSON.stringify(await response.json())).not.toContain(
			"exportFailures",
		);
	});

	it("reports an explicit dependency error when observability is not assembled", async () => {
		const { app } = createApp(admin, false);
		const response = await app.request("/api/v1/ops/observability");
		expect(response.status).toBe(503);
		expect((await response.json()) as { code: string }).toMatchObject({
			code: "DEPENDENCY_UNAVAILABLE",
		});
	});
});

// #3058：契约 getObservabilityStatus 声明的状态码；错误只能落在这些状态码上。
const declaredStatuses = Object.keys(
	observabilityOpenApiPathsV1["/api/v1/ops/observability"].get.responses,
).map(Number);
const sessionCookie = "__Host-platform-session";
const employee = { ...admin, userId: "employee-1", roles: ["employee"] };
const activeStatus = {
	enabled: true,
	state: "active" as const,
	captureFailures: 0,
	exportFailures: 2,
	droppedLogs: 1,
	invalidRecords: 0,
	lastExportFailureAt: "2026-10-13T00:00:00.000Z",
};

/**
 * 使用生产的 Health App：其 onError 会把未映射的异常变成 500，用来证明本路由不会落到那里。
 * 身份只按平台会话 Cookie 解析，与部署的浏览器身份适配器一致；请求头里的身份字段一律不读。
 */
function createContractApp(
	options: {
		sessions?: Record<string, unknown>;
		resolve?: (request: Request) => Promise<unknown>;
		status?: () => unknown;
		assembled?: boolean;
	} = {},
) {
	const app = createPlatformHealthApp();
	const sessions = options.sessions ?? {
		"admin-session": admin,
		"employee-session": employee,
	};
	const identity = {
		resolve: vi.fn(
			options.resolve ??
				(async (request: Request) => {
					const token = request.headers
						.get("cookie")
						?.split(";")
						.map((part) => part.trim().split("="))
						.find(([name]) => name === sessionCookie)?.[1];
					return (token && sessions[token]) ?? null;
				}),
		),
		hydrateUsers: vi.fn().mockResolvedValue([]),
	};
	const status = vi.fn(options.status ?? (() => activeStatus));
	registerObservabilityRoutes(app, {
		identity,
		...(options.assembled === false
			? {}
			: { observability: { status: status as () => typeof activeStatus } }),
	});
	return { app, identity, status };
}

function withSession(session: string, headers: Record<string, string> = {}) {
	return { headers: { ...headers, cookie: `${sessionCookie}=${session}` } };
}

async function protocolError(response: Response) {
	expect(declaredStatuses).toContain(response.status);
	const text = await response.text();
	return { body: PilotProtocolErrorV1Schema.parse(JSON.parse(text)), text };
}

describe("observability status contract (#3058)", () => {
	it("serves the generated V1 client with the contract projection", async () => {
		const { app } = createContractApp();
		const client = generatedClient.createClient({
			baseUrl: "https://platform.example.test",
			fetch: async (input: string | URL | Request, init?: RequestInit) => {
				const request =
					input instanceof Request ? input : new Request(input, init);
				request.headers.set("cookie", `${sessionCookie}=admin-session`);
				return app.fetch(request);
			},
		});
		const result = await generatedSdk.getObservabilityStatus({ client });
		expect(result.response.status).toBe(200);
		expect(result.data).toEqual({
			schemaVersion: 1,
			service: "platform-api",
			...activeStatus,
		});
	});

	it("requires a signed-in session before reading the status", async () => {
		const { app, status } = createContractApp();
		const response = await app.request("/api/v1/ops/observability");
		expect(response.status).toBe(401);
		expect((await protocolError(response)).body).toMatchObject({
			code: "AUTHENTICATION_REQUIRED",
			retryable: false,
		});
		expect(status).not.toHaveBeenCalled();
	});

	it("denies a non-administrator with a stable code before checking assembly", async () => {
		for (const assembled of [true, false]) {
			const { app, status } = createContractApp({ assembled });
			const response = await app.request(
				"/api/v1/ops/observability",
				withSession("employee-session"),
			);
			// 未装配观测时也先拒绝，不向普通员工透露部署是否装配了观测。
			expect(response.status).toBe(403);
			const { body, text } = await protocolError(response);
			expect(body).toMatchObject({
				code: "RESOURCE_UNAVAILABLE",
				retryable: false,
			});
			expect(text).not.toContain("exportFailures");
			expect(status).not.toHaveBeenCalled();
		}
	});

	it("refuses a disabled administrator account", async () => {
		const { app, status } = createContractApp({
			sessions: { "admin-session": { ...admin, accountStatus: "disabled" } },
		});
		const response = await app.request(
			"/api/v1/ops/observability",
			withSession("admin-session"),
		);
		expect(response.status).toBe(403);
		expect((await protocolError(response)).body).toMatchObject({
			code: "AUTHORIZATION_REVOKED",
		});
		expect(status).not.toHaveBeenCalled();
	});

	it("ignores forged identity and role headers", async () => {
		const forged = {
			"X-Platform-User-Id": "admin-1",
			"X-Platform-Roles": "system_admin",
			"X-Forwarded-User": "admin-1",
			"X-Organization-Id": "org-1",
			Authorization: "Bearer forged-administrator-token",
		};
		const { app, status } = createContractApp();
		// 普通员工会话带伪造的管理员身份头：仍按会话解析为员工并拒绝。
		const employeeResponse = await app.request(
			"/api/v1/ops/observability",
			withSession("employee-session", forged),
		);
		expect(employeeResponse.status).toBe(403);
		expect((await protocolError(employeeResponse)).body.code).toBe(
			"RESOURCE_UNAVAILABLE",
		);
		// 没有会话只带伪造头：仍是未登录。
		const anonymousResponse = await app.request("/api/v1/ops/observability", {
			headers: forged,
		});
		expect(anonymousResponse.status).toBe(401);
		expect((await protocolError(anonymousResponse)).body.code).toBe(
			"AUTHENTICATION_REQUIRED",
		);
		expect(status).not.toHaveBeenCalled();
	});

	it("returns the contract 503 when observability is not assembled", async () => {
		const { app } = createContractApp({ assembled: false });
		const response = await app.request(
			"/api/v1/ops/observability",
			withSession("admin-session"),
		);
		expect(response.status).toBe(503);
		expect((await protocolError(response)).body).toMatchObject({
			code: "DEPENDENCY_UNAVAILABLE",
			retryable: true,
		});
	});

	it("maps an identity dependency failure to the contract 503", async () => {
		const { app, status } = createContractApp({
			resolve: async () => {
				throw new Error("PRIVATE_SESSION_STORE_DETAIL");
			},
		});
		const response = await app.request(
			"/api/v1/ops/observability",
			withSession("admin-session"),
		);
		expect(response.status).toBe(503);
		const { body, text } = await protocolError(response);
		expect(body.code).toBe("DEPENDENCY_UNAVAILABLE");
		expect(text).not.toContain("PRIVATE_SESSION_STORE_DETAIL");
		expect(status).not.toHaveBeenCalled();
	});

	it.each([
		[
			"a status reader failure",
			() => {
				throw new Error("PRIVATE_EXPORTER_DETAIL");
			},
		],
		[
			"an undeclared field",
			() => ({ ...activeStatus, lastError: "PRIVATE_EXPORTER_DETAIL" }),
		],
		["a negative counter", () => ({ ...activeStatus, droppedLogs: -1 })],
		[
			"a missing counter",
			() => ({ ...activeStatus, invalidRecords: undefined }),
		],
		["a non-object status", () => "PRIVATE_EXPORTER_DETAIL"],
	])(
		"maps %s to the contract 503 instead of an undeclared 500",
		async (_name, read) => {
			const { app } = createContractApp({ status: read });
			const response = await app.request(
				"/api/v1/ops/observability",
				withSession("admin-session"),
			);
			expect(response.status).toBe(503);
			const { body, text } = await protocolError(response);
			expect(body).toMatchObject({
				code: "DEPENDENCY_UNAVAILABLE",
				retryable: true,
			});
			expect(text).not.toContain("PRIVATE_EXPORTER_DETAIL");
		},
	);
});
