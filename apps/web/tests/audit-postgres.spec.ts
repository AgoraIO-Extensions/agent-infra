import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { agentConfigurationConformanceRecordV1 as configuration } from "../../../packages/platform-core/src/agent-configuration.conformance.ts";
import { hashApiCredentialV1 } from "../../../packages/platform-core/src/api-identity.ts";
import { createConversationEventUseCaseV1 } from "../../../packages/platform-core/src/conversation-events.ts";
import { PostgresConversationEventTransactionV1 } from "../../../packages/platform-store/src/conversation-events.ts";
import { migratePlatformDatabase } from "../../../packages/platform-store/src/migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.ts";
import {
	assemblePlatformApi,
	type PlatformApiAssembly,
} from "../../platform-api/src/assembly.js";
import { startPlatformApi } from "../../platform-api/src/index.js";

interface DatabaseReader {
	unsafe(
		query: string,
		parameters?: readonly unknown[],
	): Promise<Record<string, unknown>[]>;
	end(): Promise<void>;
}
const connect = createRequire(
	import.meta.resolve("../../../packages/platform-store/package.json"),
)("postgres") as (url: string) => DatabaseReader;
const unavailable = async (): Promise<never> => {
	throw new Error("Unexpected management admission");
};
const principals = ["audit-user-a", "audit-user-b", "audit-app"] as const;
const credential = (id: string) => `synthetic-audit-credential-${id}`;
let database: PostgresTestDatabase;
let db: DatabaseReader;
let assembly: PlatformApiAssembly;
let server: ReturnType<typeof startPlatformApi>;
let origin: string;
let events: PostgresConversationEventTransactionV1;
let original: { conversationId: string; executionId: string };

// Directory identities and operation facts are synthetic; HTTP, transactions and DB are real.
test.describe("audit page over assembled HTTP and PostgreSQL", () => {
	test.describe.configure({ mode: "serial" });
	test.beforeAll(async () => {
		database = await startPostgresTestDatabase("audit-browser");
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		db = connect(database.databaseUrl);
		assembly = assemblePlatformApi({
			databaseUrl: database.databaseUrl,
			taskAdmissionPolicy: {
				maximumWaitingTasksPerAgent: 100,
				waitingTimeoutMs: 60_000,
			},
			identity: {
				async resolve(request) {
					const id = request.headers
						.get("cookie")
						?.match(/(?:^|;\s*)audit_test_identity=([^;]+)/)?.[1];
					if (
						id !== "audit-admin" &&
						id !== "audit-user-a" &&
						id !== "audit-user-b"
					)
						return null;
					return {
						schemaVersion: 1,
						userId: id,
						displayName: id,
						accountStatus: "active",
						organizationIds: [],
						roles: id === "audit-admin" ? ["system_admin"] : ["employee"],
						authorizationRevision: "audit-directory-current",
					};
				},
				async hydrateUsers(ids) {
					return ids.map((userId) => ({
						userId,
						displayName: userId,
						roles: ["employee"],
					}));
				},
				async resolveUser(userId) {
					return {
						schemaVersion: 1,
						userId,
						accountStatus: "active",
						organizationIds: [],
						authorizationRevision: "audit-directory-current",
					};
				},
			},
			admissions: {
				authorizationAdmission: { authorize: unavailable },
				imageAdmission: { admitImage: unavailable },
				modelAdmission: { admitModels: unavailable },
				secretAdmission: { admitSecrets: unavailable },
				channelAdmission: { admitChannels: unavailable },
			},
			allocateApplicationIds: unavailable,
			prepareApplicationSecrets: unavailable,
			prepareConfigurationSecrets: unavailable,
			presentAgent: unavailable,
		});
		server = startPlatformApi({
			dependencies: assembly.dependencies,
			port: 0,
			log: () => {},
		});
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		await db.unsafe(
			"insert into platform.agents(id,current_configuration_revision,authorization_revision) values($1,7,'authorization_9')",
			[configuration.agentId],
		);
		await db.unsafe(
			"insert into platform.agent_applications(id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,service_availability,desired_state,workload_revision,fence) values('audit-application',$1,'audit-user-b','Agent','Controlled audit test','available','seed-trace','seed-request',now(),11,1,'ready','running',1,1)",
			[configuration.agentId],
		);
		await db.unsafe(
			"insert into platform.agent_configuration_revisions(agent_id,revision,source_reference,created_at,configuration) values($1,7,'template_01',now(),$2::text::jsonb)",
			[configuration.agentId, JSON.stringify(configuration)],
		);
		await db.unsafe(
			"insert into platform.agent_owners(agent_id,owner_id,created_at) values($1,'audit-user-b',now())",
			[configuration.agentId],
		);
		await db.unsafe(
			"insert into platform.agent_availability(agent_id,target_type,target_id) values($1,'user','audit-user-a')",
			[configuration.agentId],
		);
		await db.unsafe(
			"insert into platform.platform_applications(id,name,responsible_user_id,authorization_revision) values('audit-app','Audit application','audit-user-b','application_current')",
		);
		for (const id of principals) {
			const kind = id === "audit-app" ? "application" : "user";
			await db.unsafe(
				"insert into platform.agent_principal_grants(agent_id,principal_type,principal_id,grant_type,authorization_revision) values($1,$2,$3,'use','authorization_9')",
				[configuration.agentId, kind, id],
			);
			await db.unsafe(
				"insert into platform.platform_api_credentials(id,principal_type,principal_id,credential_hash,scopes) values($1,$2,$3,$4,'[\"agent:use\"]'::jsonb)",
				[`credential-${id}`, kind, id, hashApiCredentialV1(credential(id))],
			);
			for (let index = 0; index < (id === "audit-user-a" ? 28 : 1); index++) {
				const task = await submit(id, `${id}-${index}`);
				if (id === "audit-user-a" && index === 0) original = task;
			}
		}
		await submit("audit-user-a", "audit-user-a-0");
		events = new PostgresConversationEventTransactionV1({
			databaseUrl: database.databaseUrl,
		});
		const producer = createConversationEventUseCaseV1({ transaction: events });
		for (const phase of ["intent", "unknown"] as const) {
			const key = `audit-tool-${phase}`;
			const persisted = await producer.persist({
				schemaVersion: 1,
				...original,
				sessionGeneration: 1,
				deliveryFence: 0,
				adapterEventKey: key,
				runtimeCursor: key,
				occurredAt: new Date().toISOString(),
				event: {
					schemaVersion: 2,
					type: "execution.operation",
					fact: {
						kind: "tool",
						operationRef: "audit-operation",
						attemptRef: "audit-attempt",
						toolId: "controlled-tool",
						phase,
						connection: {
							serviceRef: "connection-service",
							callRef: "bounded-call",
							verification: "unverified",
							reason: "record_unavailable",
						},
					},
				},
			});
			expect(persisted.outcome).toBe("accepted");
		}
	});
	test.afterAll(async () => {
		if (server) {
			if ("closeAllConnections" in server) server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
		await events?.close();
		await assembly?.close();
		await db?.end();
		await database?.stop();
	});

	async function submit(id: string, key: string) {
		const response = await fetch(
			`${origin}/api/v1/agents/${configuration.agentId}/tasks`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${credential(id)}`,
					"content-type": "application/json",
					"Idempotency-Key": key,
				},
				body: JSON.stringify({
					schemaVersion: 1,
					text: "PRIVATE_SYNTHETIC_AUDIT_BODY",
				}),
			},
		);
		expect(response.status).toBe(202);
		const task = (await response.json()) as {
			conversationId: string;
			executionId: string;
		};
		return {
			conversationId: task.conversationId,
			executionId: task.executionId,
		};
	}
	async function open(page: Page, id = "audit-user-a", path = "/audit") {
		await page.context().addCookies([
			{
				name: "audit_test_identity",
				value: id,
				url: test.info().project.use.baseURL ?? "http://127.0.0.1:43189",
			},
		]);
		await page.route(/\/api\//, async (route) => {
			const url = new URL(route.request().url());
			const response = await route.fetch({
				url: `${origin}${url.pathname}${url.search}`,
			});
			await route.fulfill({ response });
		});
		await page.goto(path);
		await expect(
			page.getByRole("heading", { name: "我的执行审计", exact: true }),
		).toBeVisible();
	}

	test("pages actual producer attempts, keeps original Execution and separates an unknown tool", async ({
		page,
	}, info) => {
		await open(page);
		await page
			.getByLabel("动作", { exact: true })
			.selectOption("task.api.submit.result");
		await page.getByRole("button", { name: "查询", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "查看审计详情" }),
		).toHaveCount(25);
		await page.getByRole("button", { name: "下一页", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "查看审计详情" }),
		).toHaveCount(4);
		await page.getByRole("button", { name: "上一页", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "查看审计详情" }),
		).toHaveCount(25);
		await page
			.getByLabel("Execution ID", { exact: true })
			.fill(original.executionId);
		await page.getByRole("button", { name: "查询", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "查看审计详情" }),
		).toHaveCount(2);
		await expect(
			page.getByRole("button", { name: "上一页", exact: true }),
		).toBeDisabled();
		await page.getByRole("button", { name: "查看审计详情" }).first().click();
		await expect(page.getByRole("dialog")).toContainText(original.executionId);
		await expect(page.getByRole("dialog")).toContainText("幂等重放");
		await page.keyboard.press("Escape");
		await expect(
			page.getByRole("button", { name: "查看审计详情" }).first(),
		).toBeFocused();
		await page
			.getByLabel("动作", { exact: true })
			.selectOption("execution.operation.observed");
		await page.getByLabel("结果", { exact: true }).selectOption("unknown");
		await page.getByRole("button", { name: "查询", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "查看审计详情" }),
		).toHaveCount(1);
		await page.getByRole("button", { name: "查看审计详情" }).click();
		await expect(page.getByRole("dialog")).toContainText("platform_worker");
		await expect(page.getByRole("dialog")).toContainText("关联未核实");
		await expect(page.getByRole("dialog")).toContainText("未采集");
		await expect(page.locator("body")).not.toContainText(
			"PRIVATE_SYNTHETIC_AUDIT_BODY",
		);
		await expect(page.locator("body")).not.toContainText("0 ms");
		await page.screenshot({
			path: info.outputPath("audit-postgres-detail.png"),
			animations: "disabled",
		});
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true);
	});

	test("isolates the second user and application even when the user is Owner and responsible", async ({
		page,
	}) => {
		await open(page, "audit-user-b");
		await page
			.getByLabel("动作", { exact: true })
			.selectOption("task.api.submit.result");
		await page.getByRole("button", { name: "查询", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "查看审计详情" }),
		).toHaveCount(1);
		await expect(
			page.getByRole("link", { name: "平台审计", exact: true }),
		).toHaveCount(0);
		const appResponse = await fetch(
			`${origin}/api/v1/audit?action=task.api.submit.result`,
			{ headers: { authorization: `Bearer ${credential("audit-app")}` } },
		);
		expect(appResponse.status).toBe(200);
		const appPage = await appResponse.json();
		expect(appPage.items).toHaveLength(1);
		expect(appPage.items[0].originalPrincipal).toEqual({
			kind: "application",
			id: "audit-app",
		});
		const attack = await fetch(
			`${origin}/api/v1/audit?executionId=${original.executionId}`,
			{ headers: { authorization: `Bearer ${credential("audit-app")}` } },
		);
		expect(attack.status).toBe(404);
		const denied = await page.request.get(`${origin}/api/v3/admin/audit`, {
			headers: { cookie: "audit_test_identity=audit-user-b" },
		});
		expect(denied.status()).toBe(404);
		await page
			.getByLabel("Execution ID", { exact: true })
			.fill(original.executionId);
		await page.getByRole("button", { name: "查询", exact: true }).click();
		await expect(page.getByRole("alert")).toContainText("无权访问");
		await expect(
			page.getByRole("button", { name: "查看审计详情" }),
		).toHaveCount(0);
		await expect(page.locator("body")).not.toContainText("本页 0 条");
		await page.getByRole("button", { name: "重置", exact: true }).click();
		await page
			.getByLabel("动作", { exact: true })
			.selectOption("task.api.submit.result");
		await page.getByRole("button", { name: "查询", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "查看审计详情" }),
		).toHaveCount(1);
	});

	test("administrator filters actual application records", async ({
		page,
	}, info) => {
		await open(page, "audit-admin");
		await page
			.getByRole("link", { name: "平台审计", exact: true })
			.first()
			.click();
		await expect(
			page.getByRole("heading", { name: "平台审计", exact: true }),
		).toBeVisible();
		await page
			.getByLabel("主体类型", { exact: true })
			.selectOption("application");
		await page.getByLabel("主体 ID", { exact: true }).fill("audit-app");
		await page
			.getByLabel("Agent ID", { exact: true })
			.fill(configuration.agentId);
		await page
			.getByLabel("动作", { exact: true })
			.selectOption("task.api.submit.result");
		await page.getByLabel("结果", { exact: true }).selectOption("succeeded");
		await page.getByRole("button", { name: "查询", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "查看审计详情" }),
		).toHaveCount(1);
		await page.screenshot({
			path: info.outputPath("audit-postgres-administrator.png"),
			fullPage: true,
			animations: "disabled",
		});
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true);
	});

	test("query audit failure hides rows and reports failure, then revocation removes list and detail", async ({
		page,
	}) => {
		await open(page);
		await page
			.getByLabel("Execution ID", { exact: true })
			.fill(original.executionId);
		await page.getByRole("button", { name: "查询", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "查看审计详情" }).first(),
		).toBeVisible();
		await db.unsafe(
			"create function platform.audit_browser_failure() returns trigger language plpgsql as $$ begin if NEW.action='audit.query.completed' then raise exception 'PRIVATE_DATABASE_FAILURE'; end if; return NEW; end $$",
		);
		await db.unsafe(
			"create trigger audit_browser_failure before insert on platform.audit_events for each row execute function platform.audit_browser_failure()",
		);
		try {
			await page.getByRole("button", { name: "刷新审计记录" }).click();
			await expect(page.getByRole("alert")).toContainText("审计查询失败");
			await expect(
				page.getByRole("button", { name: "查看审计详情" }),
			).toHaveCount(0);
			await expect(page.locator("body")).not.toContainText("暂无审计记录");
			await expect(page.locator("body")).not.toContainText("本页 0 条");
			await expect(page.locator("body")).not.toContainText(
				"PRIVATE_DATABASE_FAILURE",
			);
		} finally {
			await db.unsafe(
				"drop trigger audit_browser_failure on platform.audit_events",
			);
			await db.unsafe("drop function platform.audit_browser_failure()");
		}
		await page.getByRole("button", { name: "重试", exact: true }).click();
		await page.getByRole("button", { name: "查看审计详情" }).first().click();
		await expect(page.getByRole("dialog")).toContainText(original.executionId);
		await db.unsafe(
			"delete from platform.agent_availability where agent_id=$1 and target_type='user' and target_id='audit-user-a'",
			[configuration.agentId],
		);
		try {
			await page.getByRole("button", { name: "刷新审计详情" }).click();
			await expect(page.getByRole("alert")).toContainText("无权访问");
			await expect(page.locator("body")).not.toContainText(
				original.executionId,
			);
			await expect(
				page.getByRole("button", { name: "查看审计详情" }),
			).toHaveCount(0);
		} finally {
			await db.unsafe(
				"insert into platform.agent_availability(agent_id,target_type,target_id) values($1,'user','audit-user-a')",
				[configuration.agentId],
			);
		}
	});
});
