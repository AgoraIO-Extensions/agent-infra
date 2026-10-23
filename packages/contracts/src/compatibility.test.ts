import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

// OpenAPI compatibility compares large historical artifacts in child processes.
vi.setConfig({ testTimeout: 300_000 });

const cliPath = fileURLToPath(new URL("./compatibility.mjs", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixturePath = (name: string) =>
	fileURLToPath(new URL(`../test/compatibility/${name}.json`, import.meta.url));
const pilotBrowserArtifactPath = fileURLToPath(
	new URL(
		"../artifacts/openapi/pilot-browser.v1.openapi.json",
		import.meta.url,
	),
);
const filesArtifactPath = fileURLToPath(
	new URL("../artifacts/openapi/files.v1.openapi.json", import.meta.url),
);
const runtimeHostV2ArtifactPath = fileURLToPath(
	new URL("../artifacts/openapi/runtime-host.v2.openapi.json", import.meta.url),
);
const agentCreationAuditActions = [
	"api.agent.create.accepted",
	"api.agent.create.replayed",
	"api.agent.create.refused",
	"relay_key.agent_default.replace",
];

function comparePaths(current: string, previous: string) {
	return spawnSync(
		process.execPath,
		[cliPath, "--previous", previous, "--current", current],
		{ encoding: "utf8" },
	);
}

/** #3184 之前的企微回执状态枚举：去掉末尾追加的 `new_conversation`。 */
function wecomReceiptStatusEnums(value: {
	paths: Record<string, Record<string, unknown>>;
}): unknown[][] {
	const schemaOf = (path: string) =>
		(
			value.paths[path]?.get as {
				responses: Record<
					string,
					{ content: Record<string, { schema: Record<string, unknown> }> }
				>;
			}
		)?.responses?.["200"]?.content?.["application/json"]?.schema as
			| {
					properties: {
						items?: { items: { properties: { status: { enum: unknown[] } } } };
						status?: { enum: unknown[] };
					};
			  }
			| undefined;
	const list = schemaOf("/api/v1/wecom/receipts")?.properties.items?.items
		.properties.status.enum;
	const single = schemaOf("/api/v1/wecom/receipts/{receiptId}")?.properties
		.status?.enum;
	return [list, single].filter((values): values is unknown[] =>
		Array.isArray(values),
	);
}
function restorePreWecomNewConversationContract(value: {
	paths: Record<string, Record<string, unknown>>;
}) {
	for (const values of wecomReceiptStatusEnums(value)) {
		const index = values.indexOf("new_conversation");
		if (index >= 0) values.splice(index, 1);
	}
}
/** #3227 之前的企微回执状态枚举：去掉末尾追加的 `media_rejected`。 */
function restorePreWecomMediaRejectionContract(value: {
	paths: Record<string, Record<string, unknown>>;
}) {
	for (const values of wecomReceiptStatusEnums(value)) {
		const index = values.indexOf("media_rejected");
		if (index >= 0) values.splice(index, 1);
	}
}

it("admits only the appended WeCom media-rejected receipt status (#3227)", async () => {
	const current = JSON.parse(await readFile(pilotBrowserArtifactPath, "utf8"));
	const previous = structuredClone(current);
	restorePreWecomMediaRejectionContract(previous);
	const directory = await mkdtemp(
		resolve(tmpdir(), "agent-infra-wecom-media-rejected-compat-"),
	);
	const previousPath = resolve(directory, "previous.json");
	const currentPath = resolve(directory, "current.json");
	try {
		await writeFile(previousPath, JSON.stringify(previous));
		await writeFile(currentPath, JSON.stringify(current));
		expect(comparePaths(currentPath, previousPath).status).toBe(0);
		const mutations: Record<string, (value: typeof current) => void> = {
			inventedStatus: (value) => {
				for (const values of wecomReceiptStatusEnums(value))
					values.push("media_failed");
			},
			reordered: (value) => {
				for (const values of wecomReceiptStatusEnums(value)) values.reverse();
			},
			onlyOneResponse: (value) => {
				wecomReceiptStatusEnums(value)[0]?.pop();
			},
		};
		for (const mutate of Object.values(mutations)) {
			const changed = structuredClone(current);
			mutate(changed);
			await writeFile(currentPath, JSON.stringify(changed));
			expect(comparePaths(currentPath, previousPath).status).toBe(1);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("admits only the appended WeCom new-conversation receipt status (#3184)", async () => {
	const current = JSON.parse(await readFile(pilotBrowserArtifactPath, "utf8"));
	// 基线取 #3227 追加 `media_rejected` 之前的契约，只比较 #3184 这一项追加。
	restorePreWecomMediaRejectionContract(current);
	const previous = structuredClone(current);
	restorePreWecomNewConversationContract(previous);
	const directory = await mkdtemp(
		resolve(tmpdir(), "agent-infra-wecom-new-conversation-compat-"),
	);
	const previousPath = resolve(directory, "previous.json");
	const currentPath = resolve(directory, "current.json");
	try {
		await writeFile(previousPath, JSON.stringify(previous));
		await writeFile(currentPath, JSON.stringify(current));
		expect(comparePaths(currentPath, previousPath).status).toBe(0);
		const mutations: Record<string, (value: typeof current) => void> = {
			inventedStatus: (value) => {
				for (const values of wecomReceiptStatusEnums(value))
					values.push("rotated");
			},
			reordered: (value) => {
				for (const values of wecomReceiptStatusEnums(value)) values.reverse();
			},
			onlyOneResponse: (value) => {
				wecomReceiptStatusEnums(value)[0]?.pop();
			},
		};
		for (const mutate of Object.values(mutations)) {
			const changed = structuredClone(current);
			mutate(changed);
			await writeFile(currentPath, JSON.stringify(changed));
			expect(comparePaths(currentPath, previousPath).status).toBe(1);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("admits only the reviewed installation paths, headers and restricted response", async () => {
	const current = JSON.parse(
		await readFile(
			new URL(
				"../artifacts/openapi/pilot-browser.v2.openapi.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	const paths = [
		"/api/connection-installations",
		"/api/connection-installations/{authorizationId}",
		"/api/connection-installations/{authorizationId}/confirm",
	];
	const installationPath = paths[0];
	if (!installationPath) throw new Error("installation path fixture missing");
	const previous = structuredClone(current);
	for (const path of paths) delete previous.paths[path];
	const directory = await mkdtemp(resolve(tmpdir(), "installation-compat-"));
	const before = resolve(directory, "previous.json");
	const after = resolve(directory, "current.json");
	try {
		await writeFile(before, JSON.stringify(previous));
		await writeFile(after, JSON.stringify(current));
		expect(comparePaths(after, before).status).toBe(0);
		for (const mutate of [
			(document: typeof current) => {
				document.paths[installationPath].post.security = [];
			},
			(document: typeof current) => {
				document.paths[installationPath].post.parameters = [];
			},
			(document: typeof current) => {
				document.paths[installationPath].post.responses[202].content[
					"application/json"
				].schema.properties.token = { type: "string" };
			},
		]) {
			const changed = structuredClone(current);
			mutate(changed);
			await writeFile(after, JSON.stringify(changed));
			expect(comparePaths(after, before).status).toBe(1);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

function compare(current: string, previous = "base") {
	return comparePaths(fixturePath(current), fixturePath(previous));
}

// #3070：Owner 读取的 Agent 投影新增可选管理修订号；还原历史契约时属于后加内容。
function restorePreManagementRevisionContract(value: {
	components: {
		schemas: Record<string, { properties?: Record<string, unknown> }>;
	};
}) {
	for (const name of ["AgentProjectionV2", "AgentDetailProjectionV1"])
		delete value.components.schemas[name]?.properties?.managementRevision;
}

function restoreOldApiReadActions(input: unknown) {
	if (!input || typeof input !== "object") return;
	const value = input as Record<string, unknown>;
	if (Array.isArray(value.enum))
		value.enum = value.enum.filter(
			(action) => action !== "api.agent.metadata.read",
		);
	for (const child of Object.values(value)) restoreOldApiReadActions(child);
}

// #2879：从产物中移除 Skill 项目操作与 Agent 默认 Key 读取/候选动作，还原到 #2879 之前的契约。
const adminAuditActions2879 = [
	"skill.project.create",
	"skill.project.update",
	"skill.project.list",
	"skill.project.read",
	"relay_key.agent_default.read",
	"relay_key.agent_default.candidates",
] as const;

function restorePreAdminAuditActionsRegistration2879Contract(value: {
	components: { schemas: Record<string, unknown> };
}) {
	const actions = value.components.schemas.ScopedPlatformAuditActionV1 as
		| { enum?: string[] }
		| undefined;
	if (actions?.enum)
		actions.enum = actions.enum.filter(
			(action) =>
				!(adminAuditActions2879 as readonly string[]).includes(action),
		);
}

// #3258：从产物中移除企微 /new、会话不可用与入站媒体被拒绝三个动作，还原到 #3258 之前的契约。
const wecomAuditActions3258 = [
	"wecom.conversation_started",
	"wecom.conversation_unavailable",
	"wecom.media_rejected",
] as const;

function restorePreWecomAuditActionsRegistration3258Contract(value: {
	components: { schemas: Record<string, unknown> };
}) {
	const actions = value.components.schemas.ScopedPlatformAuditActionV1 as
		| { enum?: string[] }
		| undefined;
	if (actions?.enum)
		actions.enum = actions.enum.filter(
			(action) =>
				!(wecomAuditActions3258 as readonly string[]).includes(action),
		);
}

function restorePreSkillHubAuditContract(value: {
	components: { schemas: Record<string, unknown> };
}) {
	const actions = value.components.schemas.ScopedPlatformAuditActionV1 as
		| { enum?: string[] }
		| undefined;
	if (actions?.enum)
		actions.enum = actions.enum.filter(
			(action) =>
				![
					"skill.version.register",
					"skill.version.review",
					"skill.version.revoke",
					"skill.version.read",
					"skill.version.refused",
				].includes(action),
		);
}

function restorePreAgentCreationAuditContract(value: {
	components: { schemas: Record<string, unknown> };
}) {
	const actions = value.components.schemas.ScopedPlatformAuditActionV1 as
		| { enum?: string[] }
		| undefined;
	if (actions?.enum)
		actions.enum = actions.enum.filter(
			(action) => !agentCreationAuditActions.includes(action),
		);
}

function restorePreCredentialNarrowContract(value: {
	paths: Record<string, Record<string, unknown>>;
	components: { schemas: Record<string, { enum?: unknown[] }> };
}) {
	if (value.paths["/api/v2/me/api-credentials/{credentialId}"])
		delete value.paths["/api/v2/me/api-credentials/{credentialId}"].patch;
	for (const name of [
		"PersonalApiCredentialNarrowRequestV1",
		"PersonalApiCredentialNarrowResponseV1",
	])
		delete value.components.schemas[name];
	const actions = value.components.schemas.ScopedPlatformAuditActionV1;
	if (actions?.enum)
		actions.enum = actions.enum.filter(
			(action) => action !== "api.credential.narrowed",
		);
}

// Preserve every historical guard test while testing the exact list addition separately.
function restorePreCredentialManagementContract(value: {
	paths: Record<string, Record<string, unknown>>;
	components: { schemas: Record<string, { enum?: unknown[] }> };
}) {
	restorePreCredentialNarrowContract(value);
	if (value.paths["/api/v2/me/api-credentials"])
		delete value.paths["/api/v2/me/api-credentials"].get;
	for (const name of [
		"PersonalApiCredentialListQueryV1",
		"PersonalApiCredentialPageV1",
	])
		delete value.components.schemas[name];
	const actions = value.components.schemas.ScopedPlatformAuditActionV1;
	if (actions?.enum)
		actions.enum = actions.enum.filter(
			(action) => action !== "api.credential.metadata.read",
		);
}

// Keep the historical #1059/#1060 tests bound to their original contracts.
// The separate #1089 tests below pin and mutate every removed addition.
function restorePreRelayKeyContract(value: {
	paths: Record<string, Record<string, unknown>>;
	components: { schemas: Record<string, { enum?: unknown[] }> };
}) {
	restorePreCredentialManagementContract(value);
	delete value.paths["/api/v2/me/relay-key"];
	for (const name of [
		"PersonalRelayKeyStateV1",
		"PersonalRelayKeyReplaceRequestV1",
		"PersonalRelayKeyRevokeRequestV1",
	])
		delete value.components.schemas[name];
	const actions = value.components.schemas.ScopedPlatformAuditActionV1;
	if (actions?.enum)
		actions.enum = actions.enum.filter(
			(action) =>
				![
					"relay_key.personal.read",
					"relay_key.personal.replace",
					"relay_key.personal.revoke",
				].includes(String(action)),
		);
}

function restorePreApplicationUseGrantContract(value: {
	paths: Record<string, unknown>;
	components: { schemas: Record<string, unknown> };
}) {
	delete value.paths[
		"/api/v2/agents/{agentId}/application-use-grants/{applicationId}"
	];
	delete value.paths["/api/v2/agents/{agentId}/api-use-grants/{userId}"];
	delete value.components.schemas.AgentUserUseRevokeRequestV1;
	delete value.components.schemas.AgentUserUseRevokeResponseV1;
	const actions = value.components.schemas.ScopedPlatformAuditActionV1 as
		| { enum: string[] }
		| undefined;
	if (actions)
		actions.enum = actions.enum.filter(
			(action) =>
				![
					"api.agent.use.granted",
					"api.agent.use.revoked",
					"api.agent.use.replayed",
					"api.agent.use.refused",
				].includes(action),
		);
}

// Keep earlier pinned guards on their original contracts; the #481 guard is tested separately.
function restorePreAgentApiManagementContract(value: {
	paths: Record<string, unknown>;
	components: { schemas: Record<string, unknown> };
}) {
	restorePreWecomAuditActionsRegistration3258Contract(value);
	restorePreAdminAuditActionsRegistration2879Contract(value);
	restorePreSkillHubAuditContract(value);
	restorePreApplicationUseGrantContract(value);
	restorePreAgentCreationAuditContract(value);
	for (const path of [
		"/api/v2/agents/{agentId}/state",
		"/api/v2/agents/{agentId}/commands",
		"/api/v2/agents/{agentId}/application-managers/{applicationId}",
	])
		delete value.paths[path];
	if (value.paths["/api/v2/agents"])
		delete (value.paths["/api/v2/agents"] as { post?: unknown }).post;
	for (const name of [
		"AgentApiLifecycleRequestV1",
		"AgentApiLifecycleResponseV1",
		"AgentApiStateResponseV1",
		"AgentApplicationManagerRequestV1",
		"AgentApplicationManagerResponseV1",
		"AgentApiCreationRequestV1",
		"AgentApiCreationResponseV1",
	])
		delete value.components.schemas[name];
	const audit = value.components.schemas.PlatformAuditProjectionV2 as
		| {
				properties: {
					actor: { anyOf: { properties: { kind?: { const: string } } }[] };
					subjectType: { enum: string[] };
				};
		  }
		| undefined;
	if (audit) {
		audit.properties.actor.anyOf = audit.properties.actor.anyOf.filter(
			(actor) =>
				!["application", "unknown"].includes(
					actor.properties.kind?.const ?? "",
				),
		);
		audit.properties.subjectType.enum =
			audit.properties.subjectType.enum.filter((kind) => kind !== "unknown");
	}
	const actions = value.components.schemas.ScopedPlatformAuditActionV1 as
		| { enum: string[] }
		| undefined;
	if (actions)
		actions.enum = actions.enum.filter(
			(action) =>
				![
					"api.agent.state.read",
					"api.agent.manager.granted",
					"api.agent.manager.revoked",
					"api.agent.manager.replayed",
					"api.agent.lifecycle.refused",
					"api.agent.manager.refused",
					"api.agent.state.refused",
				].includes(action),
		);
}

describe("contract compatibility command", () => {
	it("admits only the exact optional application lifecycle and applicant projection fields (#2861)", async () => {
		for (const version of ["v1", "v2"]) {
			const current = JSON.parse(
				await readFile(
					new URL(
						`../artifacts/openapi/pilot-browser.${version}.openapi.json`,
						import.meta.url,
					),
					"utf8",
				),
			);
			const names = [
				"AgentApplicationProjectionV1",
				"AgentApplicationProjectionV2",
			].filter((name) => current.components.schemas[name]);
			const previous = structuredClone(current);
			for (const name of names) {
				delete previous.components.schemas[name].properties.updatedAt;
				delete previous.components.schemas[name].properties.applicant;
			}
			const directory = await mkdtemp(
				resolve(tmpdir(), "application-projection-compat-"),
			);
			const previousPath = resolve(directory, "previous.json");
			const currentPath = resolve(directory, "current.json");
			try {
				await writeFile(previousPath, JSON.stringify(previous));
				await writeFile(currentPath, JSON.stringify(current));
				expect(comparePaths(currentPath, previousPath).status).toBe(0);
				for (const name of names) {
					for (const mutate of [
						(schema: typeof current) => {
							schema.properties.updatedAt.type = "integer";
						},
						(schema: typeof current) => {
							delete schema.properties.updatedAt.pattern;
						},
						(schema: typeof current) => {
							schema.required.push("updatedAt");
						},
						(schema: typeof current) => {
							schema.required.push("applicant");
						},
						(schema: typeof current) => {
							schema.properties.applicant.anyOf[0].additionalProperties = true;
						},
						(schema: typeof current) => {
							schema.properties.applicant.anyOf[0].properties.token = {
								type: "string",
							};
						},
						(schema: typeof current) => {
							schema.properties.applicant.anyOf[0].required = ["userId"];
						},
						(schema: typeof current) => {
							delete schema.properties.name;
						},
					]) {
						const changed = structuredClone(current);
						mutate(changed.components.schemas[name]);
						await writeFile(currentPath, JSON.stringify(changed));
						expect(comparePaths(currentPath, previousPath).status).not.toBe(0);
					}
				}
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		}
	});

	it("admits only the four existing Agent creation audit actions", async () => {
		const current = JSON.parse(
			await readFile(pilotBrowserArtifactPath, "utf8"),
		);
		// 先还原 #3258 与 #2879 新增，再对比 #1574 的四个 Agent 创建动作
		restorePreWecomAuditActionsRegistration3258Contract(current);
		restorePreAdminAuditActionsRegistration2879Contract(current);
		const previous = structuredClone(current);
		restorePreAgentCreationAuditContract(previous);
		const directory = await mkdtemp(
			resolve(tmpdir(), "creation-audit-compat-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			const mutations: ((document: typeof current) => void)[] = [
				(document) =>
					document.components.schemas.ScopedPlatformAuditActionV1.enum.push(
						"api.agent.create.unreviewed",
					),
				(document) =>
					document.components.schemas.ScopedPlatformAuditActionV1.enum.shift(),
				(document) =>
					document.components.schemas.ScopedPlatformAuditActionV1.enum.pop(),
				(document) =>
					document.components.schemas.ScopedPlatformAuditActionV1.enum.push(
						agentCreationAuditActions[0],
					),
				(document) => {
					document.paths["/api/v3/admin/audit"].get.security = [{}];
				},
				(document) => {
					document.components.schemas.ScopedPlatformAuditProjectionV1.properties.credential =
						{ type: "string" };
				},
				(document) => {
					document.components.schemas.ScopedPlatformAuditProjectionV1.properties.actor.additionalProperties = true;
				},
				(document) => {
					document.components.schemas.ScopedPlatformAuditProjectionV1.properties.subject.additionalProperties = true;
				},
			];
			for (const mutate of mutations) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(currentPath, JSON.stringify(changed));
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("admits only the six admin audit actions registered in #2879", async () => {
		const current = JSON.parse(
			await readFile(pilotBrowserArtifactPath, "utf8"),
		);
		// 先还原 #3258 新增
		restorePreWecomAuditActionsRegistration3258Contract(current);
		// 恢复到 #2879 之前的契约（去掉这 6 个动作）
		const previous = structuredClone(current);
		restorePreAdminAuditActionsRegistration2879Contract(previous);
		const directory = await mkdtemp(
			resolve(tmpdir(), "admin-audit-2879-compat-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			// 绿灯：精确新增应该通过
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			// 变异测试：以下任何篡改都必须导致门禁失败
			const mutations: ((document: typeof current) => void)[] = [
				// 添加一个未登记的额外动作
				(document) =>
					document.components.schemas.ScopedPlatformAuditActionV1.enum.push(
						"skill.project.unreviewed",
					),
				// 去掉最后一个已登记动作
				(document) =>
					document.components.schemas.ScopedPlatformAuditActionV1.enum.pop(),
				// 去掉第一个已登记动作（颠倒顺序验证）
				(document) =>
					document.components.schemas.ScopedPlatformAuditActionV1.enum.splice(
						document.components.schemas.ScopedPlatformAuditActionV1.enum.indexOf(
							"skill.project.create",
						),
						1,
					),
			];
			for (const mutate of mutations) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(currentPath, JSON.stringify(changed));
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("admits only the three WeCom audit actions registered in #3258", async () => {
		const current = JSON.parse(
			await readFile(pilotBrowserArtifactPath, "utf8"),
		);
		// 恢复到 #3258 之前的契约（去掉这 3 个动作）
		const previous = structuredClone(current);
		restorePreWecomAuditActionsRegistration3258Contract(previous);
		const directory = await mkdtemp(
			resolve(tmpdir(), "wecom-audit-3258-compat-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			// 绿灯：精确新增应该通过
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			const actions = (document: typeof current) =>
				document.components.schemas.ScopedPlatformAuditActionV1
					.enum as string[];
			// 变异测试：以下任何篡改都必须导致门禁失败
			const mutations: ((document: typeof current) => void)[] = [
				// 添加一个没有写入方的企微动作
				(document) => actions(document).push("wecom.not_registered"),
				// 少登记一个动作
				(document) => actions(document).pop(),
				// 调换新增动作的顺序
				(document) => {
					const list = actions(document);
					const index = list.indexOf("wecom.conversation_started");
					list.splice(
						index,
						2,
						"wecom.conversation_unavailable",
						"wecom.conversation_started",
					);
				},
				// 新增动作夹带删除已有动作
				(document) =>
					actions(document).splice(actions(document).indexOf("wecom.sent"), 1),
				// 新增动作夹带其他 schema 变化
				(document) => {
					document.components.schemas.ScopedPlatformAuditProjectionV1.additionalProperties = true;
				},
			];
			for (const mutate of mutations) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(currentPath, JSON.stringify(changed));
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("admits only the pinned audit display-name V2 entries (#2909)", async () => {
		const current = JSON.parse(
			await readFile(pilotBrowserArtifactPath, "utf8"),
		);
		const paths = [
			"/api/v2/audit",
			"/api/v2/audit/{auditId}",
			"/api/v4/admin/audit",
			"/api/v4/admin/audit/{auditId}",
		];
		const previous = structuredClone(current);
		for (const path of paths) delete previous.paths[path];
		delete previous.components.schemas.ScopedPlatformAuditProjectionV2;
		delete previous.components.schemas.ScopedPlatformAuditPageV2;
		const directory = await mkdtemp(
			resolve(tmpdir(), "audit-display-name-v2-compat-"),
		);
		try {
			const before = resolve(directory, "before.json");
			const after = resolve(directory, "after.json");
			await writeFile(before, JSON.stringify(previous));
			await writeFile(after, JSON.stringify(current));
			expect(comparePaths(after, before).status).toBe(0);
			for (const mutate of [
				// 管理员入口只接受平台会话，不能改成 Bearer 或匿名。
				(value: typeof current) => {
					value.paths["/api/v4/admin/audit"].get.security = [
						{ PlatformSession: [] },
						{ platformApiCredential: [] },
					];
				},
				(value: typeof current) => {
					value.paths["/api/v2/audit/{auditId}"].get.security = [];
				},
				// V2 投影保持 strict，不能带出凭证、正文或任意字段。
				(value: typeof current) => {
					value.components.schemas.ScopedPlatformAuditProjectionV2.additionalProperties = true;
				},
				(value: typeof current) => {
					value.components.schemas.ScopedPlatformAuditProjectionV2.properties.credential =
						{ type: "string" };
				},
				(value: typeof current) => {
					value.components.schemas.ScopedPlatformAuditProjectionV2.properties.actor.additionalProperties = true;
				},
				// 名称有上限。
				(value: typeof current) => {
					delete value.components.schemas.ScopedPlatformAuditProjectionV2
						.properties.agentDisplayName.anyOf[0].maxLength;
				},
				// 已发布的 V1 投影与入口保持不变。
				(value: typeof current) => {
					value.components.schemas.ScopedPlatformAuditProjectionV1.properties.agentDisplayName =
						{ type: "string" };
				},
				(value: typeof current) => {
					value.paths["/api/v1/audit"].get.responses["200"].content[
						"application/json"
					].schema = {
						$ref: "#/components/schemas/ScopedPlatformAuditPageV2",
					};
				},
				(value: typeof current) => {
					value.paths["/api/v5/admin/audit"] = structuredClone(
						value.paths["/api/v4/admin/audit"],
					);
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(after, JSON.stringify(changed));
				expect(comparePaths(after, before).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("admits only the pinned WeCom bot status V2 with QR availability (#2911)", async () => {
		const current = JSON.parse(
			await readFile(pilotBrowserArtifactPath, "utf8"),
		);
		const statusPath = "/api/v2/agents/{agentId}/wecom-bot";
		const previous = structuredClone(current);
		delete previous.paths[statusPath];
		delete previous.components.schemas.WecomBotConnectionProjectionV2;
		const directory = await mkdtemp(
			resolve(tmpdir(), "wecom-bot-qr-availability-compat-"),
		);
		try {
			const before = resolve(directory, "before.json");
			const after = resolve(directory, "after.json");
			await writeFile(before, JSON.stringify(previous));
			await writeFile(after, JSON.stringify(current));
			expect(comparePaths(after, before).status).toBe(0);
			const branches = (value: typeof current) =>
				value.components.schemas.WecomBotConnectionProjectionV2.oneOf;
			for (const mutate of [
				// 投影保持 strict，不能放宽或带出授权地址、state 与凭证。
				(value: typeof current) => {
					branches(value)[1].additionalProperties = true;
				},
				(value: typeof current) => {
					branches(value)[1].properties.authorizationUrl = {
						type: "string",
					};
				},
				(value: typeof current) => {
					branches(value)[0].properties.secret = { type: "string" };
				},
				// 不可用原因只取与配置会话响应相同的枚举。
				(value: typeof current) => {
					branches(value)[0].properties.qrUnavailableReason.enum.push(
						"unknown",
					);
				},
				(value: typeof current) => {
					branches(value)[0].required = ["status", "qrAvailable"];
				},
				// 不能新增未评审的分支或状态。
				(value: typeof current) => {
					branches(value).push({ type: "object" });
				},
				(value: typeof current) => {
					branches(value)[1].properties.status.enum.push("unknown");
				},
				(value: typeof current) => {
					value.paths[statusPath].get.operationId = "unreviewed";
				},
				// 已发布的 V1 状态响应保持只含 status。
				(value: typeof current) => {
					value.paths["/api/v1/agents/{agentId}/wecom-bot"].get.responses[
						"200"
					].content["application/json"].schema = {
						$ref: "#/components/schemas/WecomBotConnectionProjectionV2",
					};
				},
				(value: typeof current) => {
					value.paths["/api/v1/agents/{agentId}/wecom-bot"].get.responses[
						"200"
					].content["application/json"].schema.properties.qrAvailable = {
						type: "boolean",
					};
				},
				(value: typeof current) => {
					value.paths["/api/v3/agents/{agentId}/wecom-bot"] = structuredClone(
						value.paths[statusPath],
					);
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(after, JSON.stringify(changed));
				expect(comparePaths(after, before).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("admits only the pinned observability status V1 read (#3058)", async () => {
		const current = JSON.parse(
			await readFile(pilotBrowserArtifactPath, "utf8"),
		);
		const statusPath = "/api/v1/ops/observability";
		const previous = structuredClone(current);
		delete previous.paths[statusPath];
		delete previous.components.schemas.ObservabilityStatusProjectionV1;
		const directory = await mkdtemp(
			resolve(tmpdir(), "observability-status-compat-"),
		);
		try {
			const before = resolve(directory, "before.json");
			const after = resolve(directory, "after.json");
			await writeFile(before, JSON.stringify(previous));
			await writeFile(after, JSON.stringify(current));
			expect(comparePaths(after, before).status).toBe(0);
			const projection = (value: typeof current) =>
				value.components.schemas.ObservabilityStatusProjectionV1;
			const operation = (value: typeof current) => value.paths[statusPath].get;
			for (const [name, mutate] of Object.entries({
				// 只接受平台会话：不能匿名，也不能改用 API 凭证读取。
				anonymous: (value: typeof current) => {
					operation(value).security = [];
				},
				bearer: (value: typeof current) => {
					operation(value).security.push({ platformApiCredential: [] });
				},
				// 身份与角色只由服务端解析，不能由调用方参数指定。
				callerRole: (value: typeof current) => {
					operation(value).parameters = [
						{ in: "query", name: "role", schema: { type: "string" } },
					];
				},
				// 投影保持 strict 与有界，不带出未声明的指标或正文。
				openProjection: (value: typeof current) => {
					projection(value).additionalProperties = true;
				},
				extraField: (value: typeof current) => {
					projection(value).properties.cpuPercent = { type: "number" };
				},
				optionalCounter: (value: typeof current) => {
					projection(value).required = projection(value).required.filter(
						(field: string) => field !== "exportFailures",
					);
				},
				negativeCounter: (value: typeof current) => {
					delete projection(value).properties.droppedLogs.minimum;
				},
				otherService: (value: typeof current) => {
					projection(value).properties.service = { type: "string" };
				},
				// 错误只返回契约内的稳定状态码，不新增 500，也不删掉已声明的错误。
				internalError: (value: typeof current) => {
					operation(value).responses["500"] = structuredClone(
						operation(value).responses["503"],
					);
				},
				missingDenial: (value: typeof current) => {
					delete operation(value).responses["403"];
				},
				untypedSuccess: (value: typeof current) => {
					operation(value).responses["200"].content["application/json"].schema =
						{ type: "object" };
				},
				renamed: (value: typeof current) => {
					operation(value).operationId = "unreviewed";
				},
				copied: (value: typeof current) => {
					value.paths["/api/v2/ops/observability"] = structuredClone(
						value.paths[statusPath],
					);
				},
			})) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(after, JSON.stringify(changed));
				expect(comparePaths(after, before).status, name).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("admits only the pinned directory search V2 read (#3035)", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const searchPath = "/api/v2/directory/search";
		const previous = structuredClone(current);
		delete previous.paths[searchPath];
		delete previous.components.schemas.DirectorySearchItemV1;
		delete previous.components.schemas.DirectorySearchResponseV1;
		const directory = await mkdtemp(
			resolve(tmpdir(), "directory-search-compat-"),
		);
		try {
			const before = resolve(directory, "before.json");
			const after = resolve(directory, "after.json");
			await writeFile(before, JSON.stringify(previous));
			await writeFile(after, JSON.stringify(current));
			expect(comparePaths(after, before).status).toBe(0);
			const item = (value: typeof current) =>
				value.components.schemas.DirectorySearchItemV1;
			const parameter = (value: typeof current, name: string) =>
				value.paths[searchPath].get.parameters.find(
					(entry: { name: string }) => entry.name === name,
				);
			for (const mutate of [
				// 只接受平台会话，不能按查询参数指定身份或组织范围。
				(value: typeof current) => {
					value.paths[searchPath].get.security = [];
				},
				(value: typeof current) => {
					value.paths[searchPath].get.parameters.push({
						in: "query",
						name: "organizationId",
						schema: { type: "string" },
					});
				},
				// 查询参数的取值范围不能放宽。
				(value: typeof current) => {
					parameter(value, "limit").schema.maximum = 500;
				},
				(value: typeof current) => {
					delete parameter(value, "ids").schema.pattern;
				},
				(value: typeof current) => {
					parameter(value, "kind").schema.enum.push("group");
				},
				// 记录保持 strict，不能带出未声明字段。
				(value: typeof current) => {
					item(value).additionalProperties = true;
				},
				(value: typeof current) => {
					item(value).properties.phone = { type: "string" };
				},
				(value: typeof current) => {
					item(value).required = ["kind", "canonicalId"];
				},
				// 既有响应形状不变：不新增或删除顶层字段。
				(value: typeof current) => {
					value.components.schemas.DirectorySearchResponseV1.properties.schemaVersion =
						{ const: 1, type: "number" };
				},
				(value: typeof current) => {
					value.components.schemas.DirectorySearchResponseV1.required = [
						"items",
					];
				},
				// 依赖异常只返回契约内的稳定错误码，不新增 500。
				(value: typeof current) => {
					value.paths[searchPath].get.responses["500"] = structuredClone(
						value.paths[searchPath].get.responses["503"],
					);
				},
				(value: typeof current) => {
					value.paths[searchPath].get.operationId = "unreviewed";
				},
				(value: typeof current) => {
					value.paths["/api/v3/directory/search"] = structuredClone(
						value.paths[searchPath],
					);
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(after, JSON.stringify(changed));
				expect(comparePaths(after, before).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("admits only the pinned Skill Hub review queue read (#2905)", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const queuePath = "/api/v2/skills/reviews";
		const previous = structuredClone(current);
		delete previous.paths[queuePath];
		delete previous.components.schemas.SkillHubReviewQueueItemV1;
		delete previous.components.schemas.SkillHubReviewQueuePageV1;
		const directory = await mkdtemp(
			resolve(tmpdir(), "skill-hub-review-queue-compat-"),
		);
		try {
			const before = resolve(directory, "before.json");
			const after = resolve(directory, "after.json");
			await writeFile(before, JSON.stringify(previous));
			await writeFile(after, JSON.stringify(current));
			expect(comparePaths(after, before).status).toBe(0);
			for (const mutate of [
				// 队列必须要求平台会话。
				(value: typeof current) => {
					value.paths[queuePath].get.security = [];
				},
				// 投影不能放宽为任意字段或带出审核原因。
				(value: typeof current) => {
					value.components.schemas.SkillHubReviewQueueItemV1.additionalProperties = true;
				},
				(value: typeof current) => {
					value.components.schemas.SkillHubReviewQueueItemV1.properties.reviewReason =
						{ type: "string" };
				},
				// 只列待审的共享版本。
				(value: typeof current) => {
					value.components.schemas.SkillHubReviewQueueItemV1.properties.state =
						{ type: "string" };
				},
				(value: typeof current) => {
					value.components.schemas.SkillHubReviewQueueItemV1.properties.visibility.enum.push(
						"PRIVATE",
					);
				},
				// 已发布的审核命令保持不变。
				(value: typeof current) => {
					value.components.schemas.SkillHubReviewRequestV1.additionalProperties = true;
				},
				(value: typeof current) => {
					value.paths["/api/v2/unreviewed"] = {};
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(after, JSON.stringify(changed));
				expect(comparePaths(after, before).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("admits only the pinned Skill Hub review content read (#3046)", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const contentPath = "/api/v2/skills/reviews/{skillVersionId}/content";
		const previous = structuredClone(current);
		delete previous.paths[contentPath];
		delete previous.components.schemas.SkillHubReviewContentV1;
		const directory = await mkdtemp(
			resolve(tmpdir(), "skill-hub-review-content-compat-"),
		);
		try {
			const before = resolve(directory, "before.json");
			const after = resolve(directory, "after.json");
			await writeFile(before, JSON.stringify(previous));
			await writeFile(after, JSON.stringify(current));
			expect(comparePaths(after, before).status).toBe(0);
			const reviewContent = (value: typeof current) =>
				value.components.schemas.SkillHubReviewContentV1;
			for (const mutate of [
				// 审核正文必须要求平台会话。
				(value: typeof current) => {
					value.paths[contentPath].get.security = [];
				},
				// 投影保持严格，不能带出对象位置、审核原因或安装状态。
				(value: typeof current) => {
					reviewContent(value).additionalProperties = true;
				},
				(value: typeof current) => {
					reviewContent(value).properties.packageObjectVersion = {
						type: "string",
					};
				},
				(value: typeof current) => {
					reviewContent(value).properties.reviewReason = { type: "string" };
				},
				(value: typeof current) => {
					reviewContent(value).properties.installation =
						value.components.schemas.SkillHubVersionDetailV1.properties.installation;
				},
				// 正文上限沿用版本详情，资源只给清单不给内容。
				(value: typeof current) => {
					delete reviewContent(value).properties.content.oneOf[0].properties
						.body.maxLength;
				},
				(value: typeof current) => {
					reviewContent(
						value,
					).properties.content.oneOf[0].properties.resources.items.properties.content =
						{ type: "string" };
				},
				// 审核队列投影与版本详情保持不变，正文不进入队列。
				(value: typeof current) => {
					value.components.schemas.SkillHubReviewQueueItemV1.properties.body = {
						type: "string",
					};
				},
				(value: typeof current) => {
					value.components.schemas.SkillHubVersionDetailV1.properties.state.enum.push(
						"approved",
					);
				},
				(value: typeof current) => {
					value.paths["/api/v2/unreviewed"] = {};
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(after, JSON.stringify(changed));
				expect(comparePaths(after, before).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("admits only the Owner current Agent Version read and the empty binding set (#2903)", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const versionPath = "/api/v2/agents/{agentId}/skills/current-version";
		const bindingPath =
			"/api/v2/agents/{agentId}/versions/{agentVersion}/skills";
		const previous = structuredClone(current);
		delete previous.paths[versionPath];
		delete previous.components.schemas.SkillHubAgentCurrentVersionV1;
		previous.components.schemas.SkillHubAgentBindingCommandV1.properties.bindings.minItems = 1;
		const directory = await mkdtemp(
			resolve(tmpdir(), "skill-hub-agent-current-version-compat-"),
		);
		try {
			const before = resolve(directory, "before.json");
			const after = resolve(directory, "after.json");
			await writeFile(before, JSON.stringify(previous));
			await writeFile(after, JSON.stringify(current));
			expect(comparePaths(after, before).status).toBe(0);
			for (const mutate of [
				// 版本读取必须要求平台会话。
				(value: typeof current) => {
					value.paths[versionPath].get.security = [];
				},
				// 投影保持严格，不能带出 Owner 或其他字段。
				(value: typeof current) => {
					value.components.schemas.SkillHubAgentCurrentVersionV1.additionalProperties = true;
				},
				(value: typeof current) => {
					value.components.schemas.SkillHubAgentCurrentVersionV1.properties.ownerIds =
						{ type: "array", items: { type: "string" } };
				},
				// 只放开空集合，其余绑定命令约束不变。
				(value: typeof current) => {
					value.components.schemas.SkillHubAgentBindingCommandV1.properties.bindings.maxItems = 64;
				},
				(value: typeof current) => {
					value.components.schemas.SkillHubAgentBindingCommandV1.additionalProperties = true;
				},
				(value: typeof current) => {
					value.paths[bindingPath].get.operationId = "unreviewed";
				},
				(value: typeof current) => {
					value.paths["/api/v2/unreviewed"] = {};
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(after, JSON.stringify(changed));
				expect(comparePaths(after, before).status).toBe(1);
			}
			// 旧契约若没有 minItems 约束，不能借这条规则引入新入口。
			const withoutMinimum = structuredClone(previous);
			delete withoutMinimum.components.schemas.SkillHubAgentBindingCommandV1
				.properties.bindings.minItems;
			await writeFile(before, JSON.stringify(withoutMinimum));
			await writeFile(after, JSON.stringify(current));
			expect(comparePaths(after, before).status).toBe(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("admits only the exact optional Owner management revision (#3070)", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const names = ["AgentProjectionV2", "AgentDetailProjectionV1"];
		const previous = structuredClone(current);
		for (const name of names)
			delete previous.components.schemas[name].properties.managementRevision;
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-management-revision-compat-"),
		);
		const before = resolve(directory, "previous.json");
		const after = resolve(directory, "current.json");
		try {
			await writeFile(before, JSON.stringify(previous));
			await writeFile(after, JSON.stringify(current));
			expect(comparePaths(after, before).status).toBe(0);
			const field = (value: typeof current, name: string) =>
				value.components.schemas[name].properties.managementRevision;
			for (const mutate of [
				// 必须可选：老客户端与非 Owner 响应不带这个字段。
				(value: typeof current) => {
					value.components.schemas.AgentProjectionV2.required.push(
						"managementRevision",
					);
				},
				// 只能是有界的非负整数。
				(value: typeof current) => {
					field(value, "AgentProjectionV2").type = "string";
				},
				(value: typeof current) => {
					field(value, "AgentDetailProjectionV1").minimum = -1;
				},
				(value: typeof current) => {
					delete field(value, "AgentProjectionV2").maximum;
				},
				// 其他既有字段不能借这次改动变化。
				(value: typeof current) => {
					delete value.components.schemas.AgentProjectionV2.properties.name;
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(after, JSON.stringify(changed));
				expect(comparePaths(after, before).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("admits only the pinned Agent creation failure category read (#3034)", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const failurePath = "/api/v2/agents/{agentId}/creation-failure";
		const previous = structuredClone(current);
		delete previous.paths[failurePath];
		delete previous.components.schemas.AgentCreationFailureCategoryV1;
		delete previous.components.schemas.AgentCreationFailureProjectionV1;
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-creation-failure-compat-"),
		);
		try {
			const before = resolve(directory, "before.json");
			const after = resolve(directory, "after.json");
			await writeFile(before, JSON.stringify(previous));
			await writeFile(after, JSON.stringify(current));
			expect(comparePaths(after, before).status).toBe(0);
			for (const mutate of [
				// 只接受平台会话，不接受 Bearer 凭证。
				(value: typeof current) => {
					value.paths[failurePath].get.security = [
						{ PlatformSession: [] },
						{ platformApiCredential: [] },
					];
				},
				// 投影保持 strict，不能带出原因码、次数或 Kubernetes 细节。
				(value: typeof current) => {
					value.components.schemas.AgentCreationFailureProjectionV1.additionalProperties = true;
				},
				(value: typeof current) => {
					value.components.schemas.AgentCreationFailureProjectionV1.properties.reason =
						{ type: "string" };
				},
				// 类别集合固定。
				(value: typeof current) => {
					value.components.schemas.AgentCreationFailureCategoryV1.enum.push(
						"kubernetes_policy",
					);
				},
				// 既有 V2 投影保持不变。
				(value: typeof current) => {
					value.components.schemas.AgentProjectionV2.properties.creationFailure =
						{ $ref: "#/components/schemas/AgentCreationFailureCategoryV1" };
				},
				(value: typeof current) => {
					value.paths["/api/v2/unreviewed"] = {};
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(after, JSON.stringify(changed));
				expect(comparePaths(after, before).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("admits only the pinned Agent detail with Owner status (#2910)", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		restorePreManagementRevisionContract(current);
		const detailPath = "/api/v2/agents/{agentId}/detail";
		const previous = structuredClone(current);
		delete previous.paths[detailPath];
		delete previous.components.schemas.AgentOwnerProjectionV1;
		delete previous.components.schemas.AgentDetailConfigurationProjectionV1;
		delete previous.components.schemas.AgentDetailProjectionV1;
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-detail-owner-status-compat-"),
		);
		try {
			const before = resolve(directory, "before.json");
			const after = resolve(directory, "after.json");
			await writeFile(before, JSON.stringify(previous));
			await writeFile(after, JSON.stringify(current));
			expect(comparePaths(after, before).status).toBe(0);
			const owner = (value: typeof current) =>
				value.components.schemas.AgentOwnerProjectionV1;
			for (const mutate of [
				// 详情只接受平台会话，不接受 Bearer 凭证。
				(value: typeof current) => {
					value.paths[detailPath].get.security = [
						{ PlatformSession: [] },
						{ platformApiCredential: [] },
					];
				},
				// Owner 投影保持 strict，不能带出邮箱、角色或禁用原因。
				(value: typeof current) => {
					owner(value).additionalProperties = true;
				},
				(value: typeof current) => {
					owner(value).properties.email = { type: "string" };
				},
				(value: typeof current) => {
					owner(value).properties.disabledReason = { type: "string" };
				},
				// 状态集合固定，未知状态不能被接受为有效。
				(value: typeof current) => {
					owner(value).properties.status.enum.push("unknown");
				},
				(value: typeof current) => {
					value.components.schemas.AgentDetailProjectionV1.additionalProperties = true;
				},
				// 既有 V2 投影的 Owner 形状不变。
				(value: typeof current) => {
					value.components.schemas.AgentProjectionV2.properties.configuration =
						value.components.schemas.AgentDetailProjectionV1.properties.configuration;
				},
				(value: typeof current) => {
					value.paths["/api/v2/unreviewed"] = {};
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(after, JSON.stringify(changed));
				expect(comparePaths(after, before).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("admits only the pinned administrator single-Agent read (#3033)", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const path = "/api/v2/admin/agents/{agentId}";
		const previous = structuredClone(current);
		delete previous.paths[path];
		const directory = await mkdtemp(
			resolve(tmpdir(), "administrator-agent-detail-compat-"),
		);
		try {
			const before = resolve(directory, "before.json");
			const after = resolve(directory, "after.json");
			await writeFile(before, JSON.stringify(previous));
			await writeFile(after, JSON.stringify(current));
			expect(comparePaths(after, before).status).toBe(0);
			for (const mutate of [
				// 只接受平台会话，不接受 Bearer 凭证，也不能去掉鉴权。
				(value: typeof current) => {
					value.paths[path].get.security = [
						{ PlatformSession: [] },
						{ platformApiCredential: [] },
					];
				},
				(value: typeof current) => {
					value.paths[path].get.security = [];
				},
				// 响应复用已发布的 AgentProjectionV2，不能换成其他投影。
				(value: typeof current) => {
					value.paths[path].get.responses["200"].content[
						"application/json"
					].schema = { $ref: "#/components/schemas/AgentProjectionV1" };
				},
				// 不接受查询参数选择范围或身份。
				(value: typeof current) => {
					value.paths[path].get.parameters.push({
						in: "query",
						name: "scope",
						required: false,
						schema: { type: "string" },
					});
				},
				// 已发布的 strict 投影与其他入口保持不变。
				(value: typeof current) => {
					value.components.schemas.AgentProjectionV2.properties.applicantId = {
						type: "string",
					};
				},
				(value: typeof current) => {
					value.paths["/api/v2/unreviewed"] = {};
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(after, JSON.stringify(changed));
				expect(comparePaths(after, before).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("admits only the pinned Skill Hub version detail and owned-version reads (#2904)", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const detailPath = "/api/v2/skills/versions/{skillVersionId}/detail";
		const ownedPath = "/api/v2/skills/owned-versions";
		const previous = structuredClone(current);
		delete previous.paths[detailPath];
		delete previous.paths[ownedPath];
		delete previous.components.schemas.SkillHubOwnedVersionV1;
		delete previous.components.schemas.SkillHubOwnedVersionPageV1;
		delete previous.components.schemas.SkillHubVersionDetailV1;
		const directory = await mkdtemp(
			resolve(tmpdir(), "skill-hub-version-detail-compat-"),
		);
		try {
			const before = resolve(directory, "before.json");
			const after = resolve(directory, "after.json");
			await writeFile(before, JSON.stringify(previous));
			await writeFile(after, JSON.stringify(current));
			expect(comparePaths(after, before).status).toBe(0);
			const detail = (value: typeof current) =>
				value.components.schemas.SkillHubVersionDetailV1;
			for (const mutate of [
				// 两条读取都必须要求平台会话。
				(value: typeof current) => {
					value.paths[detailPath].get.security = [];
				},
				(value: typeof current) => {
					value.paths[ownedPath].get.security = [];
				},
				// 投影不能放宽为任意字段，也不能带出对象位置或审核原因。
				(value: typeof current) => {
					detail(value).additionalProperties = true;
				},
				(value: typeof current) => {
					detail(value).properties.packageObjectVersion = { type: "string" };
				},
				(value: typeof current) => {
					detail(value).properties.reviewReason = { type: "string" };
				},
				// 正文保持有界，资源只给清单不给内容。
				(value: typeof current) => {
					delete detail(value).properties.content.oneOf[0].properties.body
						.maxLength;
				},
				(value: typeof current) => {
					detail(
						value,
					).properties.content.oneOf[0].properties.resources.items.properties.content =
						{ type: "string" };
				},
				// 安装状态只描述本人，不接受其他主体字段。
				(value: typeof current) => {
					detail(
						value,
					).properties.installation.oneOf[0].properties.principalId = {
						type: "string",
					};
				},
				(value: typeof current) => {
					value.components.schemas.SkillHubOwnedVersionV1.additionalProperties = true;
				},
				// 已发布目录与原版本读取仍只返回 published。
				(value: typeof current) => {
					value.components.schemas.SkillHubVersionMetadataV1.properties.state =
						detail(value).properties.state;
				},
				(value: typeof current) => {
					value.paths["/api/v2/unreviewed"] = {};
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(after, JSON.stringify(changed));
				expect(comparePaths(after, before).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("admits only the pinned Skill Hub installation list read (#2953)", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const listPath = "/api/v2/skills/installations";
		const previous = structuredClone(current);
		delete previous.paths[listPath].get;
		delete previous.components.schemas.SkillHubInstallationListItemV1;
		delete previous.components.schemas.SkillHubInstallationPageV1;
		const directory = await mkdtemp(
			resolve(tmpdir(), "skill-hub-installation-list-compat-"),
		);
		try {
			const before = resolve(directory, "before.json");
			const after = resolve(directory, "after.json");
			await writeFile(before, JSON.stringify(previous));
			await writeFile(after, JSON.stringify(current));
			expect(comparePaths(after, before).status).toBe(0);
			const item = (value: typeof current) =>
				value.components.schemas.SkillHubInstallationListItemV1;
			for (const mutate of [
				// 列表必须要求平台会话，不能改成按查询参数指定主体。
				(value: typeof current) => {
					value.paths[listPath].get.security = [];
				},
				(value: typeof current) => {
					value.paths[listPath].get.parameters.push({
						in: "query",
						name: "principalId",
						schema: { type: "string" },
					});
				},
				// 投影不能放宽为任意字段，也不能带出主体或对象位置。
				(value: typeof current) => {
					item(value).additionalProperties = true;
				},
				(value: typeof current) => {
					item(value).properties.principalId = { type: "string" };
				},
				(value: typeof current) => {
					item(
						value,
					).properties.version.oneOf[0].properties.packageObjectVersion = {
						type: "string",
					};
				},
				// 不可见版本不带名称。
				(value: typeof current) => {
					item(value).properties.version.oneOf[1].properties.name = {
						type: "string",
					};
				},
				(value: typeof current) => {
					delete value.components.schemas.SkillHubInstallationPageV1.properties
						.items.maxItems;
				},
				// 已发布的安装命令与响应保持不变。
				(value: typeof current) => {
					value.components.schemas.SkillHubInstallationV1.additionalProperties = true;
				},
				(value: typeof current) => {
					value.paths[listPath].post.security = [];
				},
				(value: typeof current) => {
					value.paths["/api/v2/unreviewed"] = {};
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(after, JSON.stringify(changed));
				expect(comparePaths(after, before).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("admits only the pinned Skill Hub project content and web publication (#2906)", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const contentPath = "/api/v2/skills/projects/{projectId}/content";
		const publishPath = "/api/v2/skills/projects/{projectId}/versions";
		const schemas = [
			"SkillHubProjectContentV1",
			"SkillHubProjectContentUpdateV1",
			"SkillHubProjectContentSaveResponseV1",
			"SkillHubProjectPublicationRequestV1",
		];
		const previous = structuredClone(current);
		delete previous.paths[contentPath];
		delete previous.paths[publishPath];
		for (const name of schemas) delete previous.components.schemas[name];
		const directory = await mkdtemp(
			resolve(tmpdir(), "skill-hub-project-content-compat-"),
		);
		try {
			const before = resolve(directory, "before.json");
			const after = resolve(directory, "after.json");
			await writeFile(before, JSON.stringify(previous));
			await writeFile(after, JSON.stringify(current));
			expect(comparePaths(after, before).status).toBe(0);
			const publication = (value: typeof current) =>
				value.components.schemas.SkillHubProjectPublicationRequestV1;
			const update = (value: typeof current) =>
				value.components.schemas.SkillHubProjectContentUpdateV1;
			for (const mutate of [
				// 三个入口都必须要求平台会话，写入必须带幂等键。
				(value: typeof current) => {
					value.paths[contentPath].get.security = [];
				},
				(value: typeof current) => {
					value.paths[contentPath].put.security = [];
				},
				(value: typeof current) => {
					value.paths[publishPath].post.security = [];
				},
				(value: typeof current) => {
					value.paths[publishPath].post.parameters = value.paths[
						publishPath
					].post.parameters.filter(
						(parameter: { in: string }) => parameter.in !== "header",
					);
				},
				// 浏览器不能提交对象版本、摘要、签名、来源或组织。
				(value: typeof current) => {
					publication(value).additionalProperties = true;
				},
				(value: typeof current) => {
					publication(value).properties.packageObjectVersion = {
						type: "string",
					};
				},
				(value: typeof current) => {
					publication(value).properties.signatureDigest = { type: "string" };
				},
				(value: typeof current) => {
					publication(value).properties.organizationId = { type: "string" };
				},
				// 内容保持有界，路径只能在规范布局内。
				(value: typeof current) => {
					delete update(value).properties.files.maxItems;
				},
				(value: typeof current) => {
					delete update(value).properties.files.items.oneOf[0].properties
						.content.maxLength;
				},
				(value: typeof current) => {
					update(
						value,
					).properties.files.items.oneOf[0].properties.path.pattern = "^.+$";
				},
				// 已发布的版本登记、发布响应与项目投影保持不变。
				(value: typeof current) => {
					value.components.schemas.SkillHubPublicationRequestV1.additionalProperties = true;
				},
				(value: typeof current) => {
					value.components.schemas.SkillHubPublicationResponseV1.properties.content =
						{ type: "string" };
				},
				(value: typeof current) => {
					value.components.schemas.SkillHubProjectV1.properties.files = {
						type: "array",
					};
				},
				(value: typeof current) => {
					value.paths["/api/v2/unreviewed"] = {};
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(after, JSON.stringify(changed));
				expect(comparePaths(after, before).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("admits only the exact direct Agent creation contract", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const previous = structuredClone(current);
		delete previous.paths["/api/v2/agents"].post;
		delete previous.components.schemas.AgentApiCreationRequestV1;
		delete previous.components.schemas.AgentApiCreationResponseV1;
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-api-create-compat-"),
		);
		try {
			const before = resolve(directory, "before.json");
			const after = resolve(directory, "after.json");
			await writeFile(before, JSON.stringify(previous));
			await writeFile(after, JSON.stringify(current));
			expect(comparePaths(after, before).status).toBe(0);
			for (const mutate of [
				(value: typeof current) => {
					delete value.paths["/api/v2/agents"].post.security;
				},
				(value: typeof current) => {
					value.components.schemas.AgentApiCreationResponseV1.additionalProperties = true;
				},
				(value: typeof current) => {
					value.paths["/api/v2/agents"].get.operationId = "unreviewed";
				},
				(value: typeof current) => {
					value.components.schemas.AgentApiCreationRequestV1.anyOf[1].properties.defaultRelayKey.writeOnly = false;
				},
				(value: typeof current) => {
					value.paths["/api/v2/unreviewed"] = {};
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(after, JSON.stringify(changed));
				expect(comparePaths(after, before).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("admits exactly the Skill lifecycle audit actions without authority or privacy drift", async () => {
		const current = JSON.parse(
			await readFile(pilotBrowserArtifactPath, "utf8"),
		);
		const previous = structuredClone(current);
		restorePreSkillHubAuditContract(previous);
		const directory = await mkdtemp(resolve(tmpdir(), "skill-audit-compat-"));
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			const mutations: ((document: typeof current) => void)[] = [
				(document) =>
					document.components.schemas.ScopedPlatformAuditActionV1.enum.push(
						"unreviewed.action",
					),
				(document) =>
					document.components.schemas.ScopedPlatformAuditActionV1.enum.shift(),
				(document) =>
					document.components.schemas.ScopedPlatformAuditActionV1.enum.pop(),
				(document) => {
					document.paths["/api/v3/admin/audit"].get.security = [{}];
				},
				(document) => {
					document.components.schemas.ScopedPlatformAuditProjectionV1.properties.credential =
						{ type: "string" };
				},
				(document) => {
					document.components.schemas.ScopedPlatformAuditProjectionV1.properties.subject.additionalProperties = true;
				},
			];
			for (const mutate of mutations) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(currentPath, JSON.stringify(changed));
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it.each([
		"runtime-host.v1",
		"runtime-readiness.v1",
		"pilot-browser.v1",
		"pilot-browser.v2",
	])(
		"admits only the exact optional Skill metadata addition in %s",
		async (artifact) => {
			const current = JSON.parse(
				await readFile(
					new URL(
						`../artifacts/openapi/${artifact}.openapi.json`,
						import.meta.url,
					),
					"utf8",
				),
			);
			const capability = (document: typeof current) =>
				artifact === "runtime-host.v1"
					? document.components.schemas.RuntimeCapabilitiesV1
					: artifact === "runtime-readiness.v1"
						? document.components.schemas.WorkloadReadinessResponseV1.properties
								.capabilities
						: document.components.schemas[
								artifact === "pilot-browser.v1"
									? "AgentProjectionV1"
									: "AgentProjectionV2"
							].properties.capabilities;
			const item = (document: typeof current) =>
				artifact === "runtime-host.v1"
					? document.components.schemas.RuntimeSkillCapabilityV1
					: capability(document).properties.skills.items;
			const previous = structuredClone(current);
			delete capability(previous).properties.skills;
			delete previous.components.schemas.RuntimeSkillCapabilityV1;
			const directory = await mkdtemp(
				resolve(tmpdir(), "runtime-skill-compat-"),
			);
			const previousPath = resolve(directory, "previous.json");
			const currentPath = resolve(directory, "current.json");
			try {
				await writeFile(previousPath, JSON.stringify(previous));
				await writeFile(currentPath, JSON.stringify(current));
				expect(comparePaths(currentPath, previousPath).status).toBe(0);
				const mutations: ((document: typeof current) => void)[] = [
					(document) => {
						item(document).properties.readOnly.const = false;
					},
					(document) => {
						delete item(document).properties.packageDigest.pattern;
					},
					(document) => {
						capability(document).properties.skills.maxItems = 151;
					},
					(document) => {
						capability(document).required.push("skills");
					},
					(document) => {
						item(document).properties.path = { type: "string" };
					},
					(document) => {
						item(document).required.pop();
					},
					(document) => {
						document.info.title = "Changed Runtime API";
					},
					(document) => {
						delete capability(document).properties.connection;
					},
				];
				for (const mutate of mutations) {
					const altered = structuredClone(current);
					mutate(altered);
					await writeFile(currentPath, JSON.stringify(altered));
					expect(comparePaths(currentPath, previousPath).status).not.toBe(0);
				}
			} finally {
				await rm(directory, { recursive: true });
			}
		},
	);

	it("reads the current merge-base artifacts without child-process buffer failure", () => {
		const result = spawnSync(process.execPath, [cliPath], {
			cwd: repositoryRoot,
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});
	it("admits the runtime exchange path after its schema is already published", async () => {
		const current = JSON.parse(await readFile(filesArtifactPath, "utf8"));
		const path = "/internal/v1/files/runtime-exchange";
		const added = [
			"RuntimeFileExchangeRequest",
			"RuntimeFileExchangeRequestV2",
		];
		const previous = structuredClone(current);
		delete previous.paths[path];
		for (const name of added) delete previous.components.schemas[name];
		const directory = await mkdtemp(
			resolve(tmpdir(), "runtime-file-path-compat-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			const changed = structuredClone(current);
			changed.paths[path].post.operationId = "changedRuntimeFileAccess";
			await writeFile(currentPath, JSON.stringify(changed));
			expect(comparePaths(currentPath, previousPath).status).toBe(1);
		} finally {
			await rm(directory, { recursive: true });
		}
	});
	it("admits only the reviewed V2 runtime exchange addition and keeps V1 strict", async () => {
		const current = JSON.parse(await readFile(filesArtifactPath, "utf8"));
		const path = "/internal/v1/files/runtime-exchange";
		const previous = structuredClone(current);
		delete previous.components.schemas.RuntimeFileExchangeRequest;
		delete previous.components.schemas.RuntimeFileExchangeRequestV2;
		previous.paths[path].post.requestBody.content["application/json"].schema = {
			$ref: "#/components/schemas/RuntimeFileExchangeRequestV1",
		};
		const directory = await mkdtemp(
			resolve(tmpdir(), "runtime-file-v2-compat-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			for (const mutate of [
				(document: typeof current) => {
					document.components.schemas.RuntimeFileExchangeRequestV2.oneOf[1].properties.actorId =
						{ type: "string" };
				},
				(document: typeof current) => {
					document.paths[path].post.requestBody.content[
						"application/json"
					].schema.$ref = "#/components/schemas/RuntimeFileExchangeRequestV1";
				},
				(document: typeof current) => {
					delete document.components.schemas.RuntimeFileExchangeRequestV1;
				},
			]) {
				const altered = structuredClone(current);
				mutate(altered);
				await writeFile(currentPath, JSON.stringify(altered));
				expect(comparePaths(currentPath, previousPath).status).not.toBe(0);
			}
		} finally {
			await rm(directory, { recursive: true });
		}
	});
	it("admits only the exact user API manage grant addition (#2759)", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const path = "/api/v2/agents/{agentId}/api-manage-grants/{userId}";
		const schemas = [
			"AgentUserManageGrantRequestV1",
			"AgentUserManageGrantResponseV1",
			"AgentUserManageRevokeRequestV1",
			"AgentUserManageRevokeResponseV1",
		];
		const previous = structuredClone(current);
		delete previous.paths[path];
		for (const name of schemas) delete previous.components.schemas[name];
		const dir = await mkdtemp(
			resolve(tmpdir(), "agent-infra-manage-grant-compat-"),
		);
		const before = resolve(dir, "before.json");
		const after = resolve(dir, "after.json");
		try {
			await writeFile(before, JSON.stringify(previous));
			await writeFile(after, JSON.stringify(current));
			expect(comparePaths(after, before).status).toBe(0);
			for (const mutate of [
				(value: typeof current) => {
					value.paths[path].delete.operationId = "unreviewedRevoke";
				},
				(value: typeof current) => {
					value.components.schemas.AgentUserManageGrantResponseV1.properties.credential =
						{ type: "string" };
				},
				(value: typeof current) => {
					value.info.title = "unreviewed";
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(after, JSON.stringify(changed));
				expect(comparePaths(after, before).status).toBe(1);
			}
		} finally {
			await rm(dir, { recursive: true });
		}
	});
	it.each([1, 2])(
		"admits only the exact application use grant addition for browser V%s",
		async (version) => {
			const current = JSON.parse(
				await readFile(
					new URL(
						`../artifacts/openapi/pilot-browser.v${version}.openapi.json`,
						import.meta.url,
					),
					"utf8",
				),
			);
			const previous = structuredClone(current);
			restorePreApplicationUseGrantContract(previous);
			for (const document of [current, previous]) {
				const userUsePath = "/api/v2/agents/{agentId}/api-use-grants/{userId}";
				if (document.paths[userUsePath]) delete document.paths[userUsePath].put;
				delete document.components.schemas.AgentUserUseGrantRequestV1;
				delete document.components.schemas.AgentUserUseGrantResponseV1;
			}
			const dir = await mkdtemp(
				resolve(tmpdir(), "agent-infra-use-grant-compat-"),
			);
			const before = resolve(dir, "before.json");
			const after = resolve(dir, "after.json");
			try {
				await writeFile(before, JSON.stringify(previous));
				await writeFile(after, JSON.stringify(current));
				expect(comparePaths(after, before).status).toBe(0);
				const mutations: ((value: typeof current) => void)[] = [
					(value) => {
						value.info.title = "unreviewed";
					},
				];
				if (version === 1)
					mutations.push(
						(value) => {
							value.components.schemas.ScopedPlatformAuditActionV1.enum.push(
								"api.agent.use.unreviewed",
							);
						},
						(value) => {
							value.components.schemas.ScopedPlatformAuditActionV1.enum.shift();
						},
						(value) => {
							value.components.schemas.ScopedPlatformAuditActionV1.enum =
								value.components.schemas.ScopedPlatformAuditActionV1.enum.filter(
									(action: string) => action !== "api.agent.use.revoked",
								);
						},
					);
				else
					mutations.push(
						(value) => {
							value.paths[
								"/api/v2/agents/{agentId}/application-use-grants/{applicationId}"
							].put.security = [{}];
						},
						(value) => {
							delete value.paths[
								"/api/v2/agents/{agentId}/application-use-grants/{applicationId}"
							].delete.responses["403"];
						},
						(value) => {
							value.components.schemas.AgentApplicationManagerResponseV1.properties.credentialValue =
								{ type: "string" };
						},
					);
				for (const mutate of mutations) {
					const changed = structuredClone(current);
					mutate(changed);
					await writeFile(after, JSON.stringify(changed));
					expect(comparePaths(after, before).status).toBe(1);
				}
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	);

	it.each([1, 2])(
		"admits only the exact Agent management and audit addition for browser V%s",
		async (version) => {
			const current = JSON.parse(
				await readFile(
					new URL(
						`../artifacts/openapi/pilot-browser.v${version}.openapi.json`,
						import.meta.url,
					),
					"utf8",
				),
			);
			const previous = structuredClone(current);
			restorePreAgentApiManagementContract(previous);
			for (const document of [current, previous]) {
				delete document.paths[
					"/api/v2/agents/{agentId}/api-use-grants/{userId}"
				];
				delete document.components.schemas.AgentUserUseRevokeRequestV1;
				delete document.components.schemas.AgentUserUseRevokeResponseV1;
				if (document.paths["/api/v2/agents"])
					delete document.paths["/api/v2/agents"].post;
				delete document.components.schemas.AgentApiCreationRequestV1;
				delete document.components.schemas.AgentApiCreationResponseV1;
				restorePreWecomAuditActionsRegistration3258Contract(document);
				restorePreAdminAuditActionsRegistration2879Contract(document);
				restorePreSkillHubAuditContract(document);
				restorePreAgentCreationAuditContract(document);
				for (const name of ["AgentProjectionV1", "AgentProjectionV2"]) {
					const schema = document.components.schemas[name];
					if (schema?.properties?.capabilities?.properties)
						delete schema.properties.capabilities.properties.skills;
				}
			}
			const directory = await mkdtemp(
				resolve(tmpdir(), "agent-infra-agent-management-compat-"),
			);
			const before = resolve(directory, "before.json");
			const after = resolve(directory, "after.json");
			try {
				await writeFile(before, JSON.stringify(previous));
				await writeFile(after, JSON.stringify(current));
				expect(comparePaths(after, before).status).toBe(0);
				const mutations: ((value: typeof current) => void)[] = [
					(value) => {
						value.info.title = "unreviewed authority change";
					},
				];
				if (version === 1)
					mutations.push(
						(value) => {
							value.components.schemas.ScopedPlatformAuditActionV1.enum.push(
								"api.agent.unreviewed",
							);
						},
						(value) => {
							value.components.schemas.ScopedPlatformAuditActionV1.enum.shift();
						},
					);
				if (version === 2)
					mutations.push(
						(value) => {
							value.paths["/api/v2/agents/{agentId}/commands"].post.security = [
								{},
							];
						},
						(value) => {
							delete value.paths["/api/v2/agents/{agentId}/state"].get
								.responses["403"];
						},
						(value) => {
							value.components.schemas.AgentApiLifecycleRequestV1.additionalProperties = true;
						},
						(value) => {
							value.components.schemas.AgentApiLifecycleResponseV1.properties.token =
								{ type: "string" };
						},
						(value) => {
							value.components.schemas.PlatformAuditProjectionV2.properties.actor.anyOf[2].properties.kind.const =
								"invented";
						},
					);
				for (const mutate of mutations) {
					const changed = structuredClone(current);
					mutate(changed);
					await writeFile(after, JSON.stringify(changed));
					expect(comparePaths(after, before).status).toBe(1);
				}
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	);

	it("admits only the known credential audit subject and preserves privacy and security", async () => {
		const current = JSON.parse(
			await readFile(pilotBrowserArtifactPath, "utf8"),
		);
		restorePreAgentApiManagementContract(current);
		const previous = structuredClone(current);
		const subject = (document: typeof current) =>
			document.components.schemas.ScopedPlatformAuditProjectionV1.properties
				.subject;
		subject(previous).properties.kind.enum = subject(
			previous,
		).properties.kind.enum.filter((kind: string) => kind !== "api_credential");
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-credential-subject-compat-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			const beforeNarrow = structuredClone(previous);
			restorePreCredentialNarrowContract(beforeNarrow);
			await writeFile(previousPath, JSON.stringify(beforeNarrow));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			await writeFile(previousPath, JSON.stringify(previous));
			const mutations: ((document: typeof current) => void)[] = [
				(document) => {
					document.components.schemas.ScopedPlatformAuditActionV1.enum =
						document.components.schemas.ScopedPlatformAuditActionV1.enum.filter(
							(action: string) => action !== "api.credential.narrowed",
						);
				},
				(document) =>
					subject(document).properties.kind.enum.push("invented_credential"),
				(document) => subject(document).properties.kind.enum.shift(),
				(document) => {
					subject(document).properties.subjectId.minLength = 0;
				},
				(document) => {
					subject(document).additionalProperties = true;
				},
				(document) => {
					document.components.schemas.ScopedPlatformAuditProjectionV1.additionalProperties = true;
				},
				(document) => {
					document.paths["/api/v3/admin/audit"].get.security = [{}];
				},
				(document) => {
					document.paths["/api/v1/audit"].get.security = [];
				},
				(document) =>
					document.components.schemas.ScopedPlatformAuditActionV1.enum.push(
						"unreviewed.action",
					),
			];
			for (const field of [
				"credential",
				"credentialHash",
				"scopes",
				"expiresAt",
				"details",
			]) {
				mutations.push((document) => {
					subject(document).properties[field] = { type: "string" };
				});
			}
			for (const mutate of mutations) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(currentPath, JSON.stringify(changed));
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}, 120_000);

	it("admits only exact scoped audit cookie/Bearer documentation and rejects authority drift", async () => {
		const current = JSON.parse(
			await readFile(pilotBrowserArtifactPath, "utf8"),
		);
		const previous = structuredClone(current);
		for (const path of ["/api/v1/audit", "/api/v1/audit/{auditId}"])
			previous.paths[path].get.security = [{}];
		for (const path of ["/api/v3/admin/audit", "/api/v3/admin/audit/{auditId}"])
			previous.paths[path].get.security = [];
		delete previous.components.securitySchemes;
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-audit-auth-compat-"),
		);
		const before = resolve(directory, "previous.json");
		const after = resolve(directory, "current.json");
		try {
			await writeFile(before, JSON.stringify(previous));
			await writeFile(after, JSON.stringify(current));
			expect(comparePaths(after, before).status).toBe(0);
			const withExistingSchemes = structuredClone(previous);
			withExistingSchemes.components.securitySchemes = structuredClone(
				current.components.securitySchemes,
			);
			await writeFile(before, JSON.stringify(withExistingSchemes));
			expect(comparePaths(after, before).status).toBe(0);
			await writeFile(before, JSON.stringify(previous));
			const mutations = [
				(value: typeof current) => {
					value.paths["/api/v1/audit"].get.security = [{}];
				},
				(value: typeof current) => {
					value.paths["/api/v1/audit/{auditId}"].get.security = [
						{ PlatformSession: [], platformApiCredential: [] },
					];
				},
				(value: typeof current) => {
					value.paths["/api/v3/admin/audit"].get.security = [
						{ platformApiCredential: [] },
					];
				},
				(value: typeof current) => {
					value.paths["/api/v3/admin/audit/{auditId}"].get.security = [];
				},
				(value: typeof current) => {
					value.components.securitySchemes.PlatformSession.name =
						"untrusted-cookie";
				},
				(value: typeof current) => {
					value.components.securitySchemes.platformApiCredential.scheme =
						"basic";
				},
				(value: typeof current) => {
					delete value.paths["/api/v1/audit"].get.responses["401"];
				},
				(value: typeof current) => {
					value.paths["/api/v1/admin/audit"].get.security = [];
				},
			];
			for (const mutate of mutations) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(after, JSON.stringify(changed));
				expect(comparePaths(after, before).status).not.toBe(0);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each([1, 2])(
		"admits only the exact personal PATCH addition for browser V%s",
		async (version) => {
			const current = JSON.parse(
				await readFile(
					new URL(
						`../artifacts/openapi/pilot-browser.v${version}.openapi.json`,
						import.meta.url,
					),
					"utf8",
				),
			);
			restorePreAgentApiManagementContract(current);
			const previous = structuredClone(current);
			restorePreCredentialNarrowContract(previous);
			const directory = await mkdtemp(
				resolve(tmpdir(), "agent-infra-personal-narrow-compat-"),
			);
			const previousPath = resolve(directory, "previous.json");
			const currentPath = resolve(directory, "current.json");
			try {
				await writeFile(previousPath, JSON.stringify(previous));
				await writeFile(currentPath, JSON.stringify(current));
				expect(comparePaths(currentPath, previousPath).status).toBe(0);
				const beforeGet = structuredClone(previous);
				restorePreCredentialManagementContract(beforeGet);
				await writeFile(previousPath, JSON.stringify(beforeGet));
				expect(comparePaths(currentPath, previousPath).status).toBe(0);
				await writeFile(previousPath, JSON.stringify(previous));
				const mutations: ((document: typeof current) => void)[] =
					version === 1
						? [
								(document) => {
									document.components.schemas.ScopedPlatformAuditActionV1.enum.push(
										"unreviewed.action",
									);
								},
								(document) => {
									document.components.schemas.ScopedPlatformAuditActionV1.enum.splice(
										0,
										1,
									);
								},
							]
						: [
								(document) => {
									document.paths["/api/v2/me/api-credentials"].get.security = [
										{},
									];
								},
								(document) => {
									document.paths[
										"/api/v2/me/api-credentials/{credentialId}"
									].patch.parameters = [];
								},
								(document) => {
									delete document.components.schemas
										.PersonalApiCredentialNarrowRequestV1.minProperties;
								},
								(document) => {
									document.components.schemas.PersonalApiCredentialNarrowRequestV1.properties.expiresAt.type =
										["string", "null"];
								},
								(document) => {
									document.components.schemas.PersonalApiCredentialPageV1.properties.credential =
										{ type: "string" };
								},
								(document) => {
									document.paths["/api/v2/me/api-credentials"].post.security = [
										{},
									];
								},
								(document) => {
									document.components.securitySchemes.PlatformSession = {};
								},
							];
				mutations.push(
					(document) => {
						document.paths["/unreviewed"] = {};
					},
					(document) => {
						document.components.schemas.Unreviewed = { type: "object" };
					},
				);
				for (const mutate of mutations) {
					const changed = structuredClone(current);
					mutate(changed);
					await writeFile(currentPath, JSON.stringify(changed));
					expect(comparePaths(currentPath, previousPath).status).toBe(1);
				}
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	);

	it.each([1, 2])(
		"admits only the exact personal list addition for browser V%s",
		async (version) => {
			const current = JSON.parse(
				await readFile(
					new URL(
						`../artifacts/openapi/pilot-browser.v${version}.openapi.json`,
						import.meta.url,
					),
					"utf8",
				),
			);
			restorePreAgentApiManagementContract(current);
			restorePreCredentialNarrowContract(current);
			const previous = structuredClone(current);
			restorePreCredentialManagementContract(previous);
			const directory = await mkdtemp(
				resolve(tmpdir(), "agent-infra-personal-list-compat-"),
			);
			const previousPath = resolve(directory, "previous.json");
			const currentPath = resolve(directory, "current.json");
			try {
				await writeFile(previousPath, JSON.stringify(previous));
				await writeFile(currentPath, JSON.stringify(current));
				expect(comparePaths(currentPath, previousPath).status).toBe(0);
				const mutations: ((document: typeof current) => void)[] =
					version === 1
						? [
								(document) => {
									document.components.schemas.ScopedPlatformAuditActionV1.enum.push(
										"unreviewed.action",
									);
								},
								(document) => {
									document.components.schemas.ScopedPlatformAuditActionV1.enum.splice(
										0,
										1,
									);
								},
							]
						: [
								(document) => {
									document.paths["/api/v2/me/api-credentials"].get.security = [
										{},
									];
								},
								(document) => {
									document.paths["/api/v2/me/api-credentials"].get.parameters =
										[];
								},
								(document) => {
									document.components.schemas.PersonalApiCredentialPageV1.properties.items.maxItems = 200;
								},
								(document) => {
									document.components.schemas.PersonalApiCredentialPageV1.properties.credential =
										{ type: "string" };
								},
								(document) => {
									document.paths["/api/v2/me/api-credentials"].post.security = [
										{},
									];
								},
								(document) => {
									document.components.securitySchemes.PlatformSession = {};
								},
							];
				mutations.push(
					(document) => {
						document.paths["/unreviewed"] = {};
					},
					(document) => {
						document.components.schemas.Unreviewed = { type: "object" };
					},
				);
				for (const mutate of mutations) {
					const changed = structuredClone(current);
					mutate(changed);
					await writeFile(currentPath, JSON.stringify(changed));
					expect(comparePaths(currentPath, previousPath).status).toBe(1);
				}
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	);

	it("admits only the exact own-application disable PATCH preserving old interfaces", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const path = "/api/v2/applications/{applicationId}";
		const previous = structuredClone(current);
		delete previous.paths[path].patch;
		delete previous.components.schemas.ApplicationDisableRequestV1;
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-application-disable-compat-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			for (const mutate of [
				(value: typeof current) => {
					delete value.paths[path].patch.security;
				},
				(value: typeof current) => {
					delete value.paths[path].patch.parameters;
				},
				(value: typeof current) => {
					value.components.schemas.ApplicationDisableRequestV1.additionalProperties = true;
				},
				(value: typeof current) => {
					value.components.schemas.ApplicationDisableRequestV1.properties.status.const =
						"active";
				},
				(value: typeof current) => {
					delete value.paths[path].get.security;
				},
				(value: typeof current) => {
					delete value.components.securitySchemes.PlatformSession;
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(currentPath, JSON.stringify(changed));
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("admits only the exact own-application GET without changing prior contracts", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const path = "/api/v2/applications/{applicationId}";
		// Keep the historical GET admission fixture independent of #1219 PATCH.
		delete current.paths[path].patch;
		delete current.components.schemas.ApplicationDisableRequestV1;
		const previous = structuredClone(current);
		delete previous.paths[path];
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-own-application-compat-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			for (const mutate of [
				(document: typeof current) => {
					document.paths[path].post = document.paths[path].get;
				},
				(document: typeof current) => {
					document.paths[path].get.security = [{}];
				},
				(document: typeof current) => {
					document.paths[path].get.parameters = [];
				},
				(document: typeof current) => {
					delete document.paths[path].get.responses["200"];
				},
				(document: typeof current) => {
					document.paths[path].get.requestBody = { required: false };
				},
				(document: typeof current) => {
					document.paths[path].get.responses["200"].content[
						"application/json"
					].schema = { type: "object", additionalProperties: true };
				},
				(document: typeof current) => {
					document.components.schemas.ApplicationMetadataV1.properties.credential =
						{ type: "string" };
				},
				(document: typeof current) => {
					document.paths["/api/v2/applications"].post.operationId = "changed";
				},
				(document: typeof current) => {
					document.components.securitySchemes.PlatformSession = {};
				},
				(document: typeof current) => {
					document.paths["/api/v2/unreviewed"] = {};
				},
				(document: typeof current) => {
					document.components.schemas.Unreviewed = { type: "object" };
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(currentPath, JSON.stringify(changed));
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
			const occupied = structuredClone(current);
			occupied.paths[path].get.description = "Existing contract";
			await writeFile(previousPath, JSON.stringify(occupied));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("admits only the exact application registration POST and preserves all prior contracts", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		delete current.paths["/api/v2/applications/{applicationId}"];
		delete current.components.schemas.AgentApplicationCreateRequestV2.properties
			.defaultRelayKey;
		const path = "/api/v2/applications";
		const previous = structuredClone(current);
		delete previous.paths[path];
		for (const name of [
			"ApplicationMetadataV1",
			"ApplicationRegistrationRequestV1",
			"ApplicationRegistrationResponseV1",
		])
			delete previous.components.schemas[name];
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-registration-compat-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			for (const mutate of [
				(document: typeof current) => {
					delete document.paths[path];
				},
				(document: typeof current) => {
					document.paths[path].get = document.paths[path].post;
				},
				(document: typeof current) => {
					document.paths[path].post.security = [{}];
				},
				(document: typeof current) => {
					document.paths[path].post.parameters = [];
				},
				(document: typeof current) => {
					delete document.paths[path].post.responses["403"];
				},
				(document: typeof current) => {
					document.components.schemas.ApplicationRegistrationRequestV1.additionalProperties = true;
				},
				(document: typeof current) => {
					document.components.schemas.ApplicationMetadataV1.properties.credential =
						{ type: "string" };
				},
				(document: typeof current) => {
					document.paths["/api/v2/unreviewed"] = {};
				},
				(document: typeof current) => {
					document.paths["/api/v2/agents"].get.operationId = "changed";
				},
				(document: typeof current) => {
					document.components.schemas.AgentProjectionV2.required = [];
				},
				(document: typeof current) => {
					document.components.securitySchemes.PlatformSession = {};
				},
				(document: typeof current) => {
					document.components.schemas.Unreviewed = { type: "object" };
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(currentPath, JSON.stringify(changed));
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("admits only frozen Task C HTTP contracts and preserves every old interface", async () => {
		const current = JSON.parse(
			await readFile(pilotBrowserArtifactPath, "utf8"),
		);
		// This fixture stays bound to C when the independent D slice arrives.
		delete current.paths[
			"/api/v1/conversations/{conversationId}/tasks/{executionId}/events"
		];
		for (const name of ["TaskStreamErrorV1", "TaskSseMessageV1"])
			delete current.components.schemas[name];
		const paths = [
			"/api/v1/agents/{agentId}/tasks",
			"/api/v1/conversations/{conversationId}/tasks/{executionId}",
			"/api/v1/conversations/{conversationId}/tasks/{executionId}/cancel",
		] as const;
		const schemas = [
			"SubmitTaskRequestV1",
			"TaskAcceptedV1",
			"TaskProjectionV1",
			"TaskStatusEventV1",
			"CancelTaskRequestV1",
			"TaskCancellationV1",
		];
		const previous = structuredClone(current);
		for (const path of paths) delete previous.paths[path];
		for (const name of schemas) delete previous.components.schemas[name];
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-task-c-compat-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			for (const mutate of [
				(value: typeof current) => {
					delete value.paths[paths[0]].post.parameters;
				},
				(value: typeof current) => {
					value.paths[paths[1]].get.security = [{}];
				},
				(value: typeof current) => {
					value.components.securitySchemes.platformApiCredential.scheme =
						"basic";
				},
				(value: typeof current) => {
					value.components.schemas.SubmitTaskRequestV1.additionalProperties = true;
				},
				(value: typeof current) => {
					value.components.schemas.SubmitTaskRequestV1.properties.principal = {
						type: "string",
					};
				},
				(value: typeof current) => {
					value.components.schemas.TaskStatusEventV1.properties.sequence.minimum = 0;
				},
				(value: typeof current) => {
					value.components.schemas.TaskStatusEventV1.properties.payload = {};
				},
				(value: typeof current) => {
					delete value.paths[paths[2]].post.responses["403"];
				},
				(value: typeof current) => {
					value.paths["/api/v1/unreviewed"] = {};
				},
				(value: typeof current) => {
					value.components.schemas.UnreviewedTaskV1 = {};
				},
				(value: typeof current) => {
					value.info.title = "changed";
				},
				(value: typeof current) => {
					value.components.schemas.AgentProjectionV1.required = [];
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(currentPath, JSON.stringify(changed));
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
			await writeFile(currentPath, JSON.stringify(current));
			for (const mutate of [
				(value: typeof previous) => {
					value.paths[paths[0]] = structuredClone(current.paths[paths[0]]);
				},
				(value: typeof previous) => {
					value.components.schemas.TaskAcceptedV1 = structuredClone(
						current.components.schemas.TaskAcceptedV1,
					);
				},
			]) {
				const occupied = structuredClone(previous);
				mutate(occupied);
				await writeFile(previousPath, JSON.stringify(occupied));
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("admits only the three pinned personal Relay Key audit actions at the existing V1 location", async () => {
		const current = JSON.parse(
			await readFile(pilotBrowserArtifactPath, "utf8"),
		);
		restorePreAgentApiManagementContract(current);
		restorePreCredentialManagementContract(current);
		const previous = structuredClone(current);
		previous.components.schemas.ScopedPlatformAuditActionV1.enum =
			previous.components.schemas.ScopedPlatformAuditActionV1.enum.filter(
				(action: string) =>
					![
						"relay_key.personal.read",
						"relay_key.personal.replace",
						"relay_key.personal.revoke",
					].includes(action),
			);
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-relay-audit-compat-"),
		);
		const baseline = resolve(directory, "previous.json");
		const historicalCurrent = resolve(directory, "historical-current.json");
		try {
			await writeFile(baseline, JSON.stringify(previous));
			await writeFile(historicalCurrent, JSON.stringify(current));
			expect(comparePaths(historicalCurrent, baseline).status).toBe(0);
			const mutations: Record<string, (value: typeof current) => void> = {
				inventedAction: (value) => {
					value.components.schemas.ScopedPlatformAuditActionV1.enum.push(
						"relay_key.personal.anything",
					);
				},
				removedOldAction: (value) => {
					value.components.schemas.ScopedPlatformAuditActionV1.enum.shift();
				},
				missingNewAction: (value) => {
					value.components.schemas.ScopedPlatformAuditActionV1.enum =
						value.components.schemas.ScopedPlatformAuditActionV1.enum.filter(
							(action: string) => action !== "relay_key.personal.revoke",
						);
				},
				keyReadback: (value) => {
					value.components.schemas.ScopedPlatformAuditProjectionV1.properties.keyValue =
						{ type: "string" };
				},
				anonymousAudit: (value) => {
					value.paths["/api/v3/admin/audit"].get.security = [{}];
				},
				missingAuthenticationFailure: (value) => {
					delete value.paths["/api/v3/admin/audit"].get.responses["401"];
				},
				missingAuthorizationFailure: (value) => {
					delete value.paths["/api/v3/admin/audit/{auditId}"].get.responses[
						"403"
					];
				},
			};
			for (const baselineKind of ["apiRead", "beforeApiRead"]) {
				const existing = structuredClone(previous);
				if (baselineKind === "beforeApiRead")
					restoreOldApiReadActions(existing);
				await writeFile(baseline, JSON.stringify(existing));
				expect(
					comparePaths(historicalCurrent, baseline).status,
					baselineKind,
				).toBe(0);
				for (const [name, mutate] of Object.entries(mutations)) {
					const candidate = structuredClone(current);
					mutate(candidate);
					expect(candidate, name).not.toEqual(current);
					const path = resolve(directory, `${name}.json`);
					await writeFile(path, JSON.stringify(candidate));
					expect(
						comparePaths(path, baseline).status,
						`${baselineKind}-${name}`,
					).toBe(1);
				}
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("admits only the pinned browser personal Relay Key path and rejects identity/material/security drift", async () => {
		const artifact = fileURLToPath(
			new URL(
				"../artifacts/openapi/pilot-browser.v2.openapi.json",
				import.meta.url,
			),
		);
		const current = JSON.parse(await readFile(artifact, "utf8"));
		const previous = structuredClone(current);
		restorePreRelayKeyContract(previous);
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-relay-key-compat-"),
		);
		const baseline = resolve(directory, "previous.json");
		try {
			await writeFile(baseline, JSON.stringify(previous));
			expect(comparePaths(artifact, baseline).status).toBe(0);
			const mutations: Record<string, (value: typeof current) => void> = {
				anonymous: (value) => {
					value.paths["/api/v2/me/relay-key"].put.security = [];
				},
				bearer: (value) => {
					value.paths["/api/v2/me/relay-key"].delete.security = [
						{ platformApiCredential: [] },
					];
				},
				callerIdentity: (value) => {
					value.components.schemas.PersonalRelayKeyReplaceRequestV1.properties.userId =
						{ type: "string" };
				},
				keyReadback: (value) => {
					value.components.schemas.PersonalRelayKeyStateV1.oneOf[1].properties.keyValue =
						{ type: "string" };
				},
				keyBounds: (value) => {
					value.components.schemas.PersonalRelayKeyReplaceRequestV1.properties.keyValue.minLength = 0;
				},
				keyPattern: (value) => {
					delete value.components.schemas.PersonalRelayKeyReplaceRequestV1
						.properties.keyValue.pattern;
				},
				zeroVersion: (value) => {
					value.components.schemas.PersonalRelayKeyRevokeRequestV1.properties.expectedVersion.minimum = 0;
				},
				unknownBodyFields: (value) => {
					value.components.schemas.PersonalRelayKeyReplaceRequestV1.additionalProperties = true;
				},
				inventedPatch: (value) => {
					value.paths["/api/v2/me/relay-key"].patch =
						value.paths["/api/v2/me/relay-key"].put;
				},
				missingFailureStatus: (value) => {
					delete value.paths["/api/v2/me/relay-key"].put.responses["503"];
				},
				changedCookie: (value) => {
					value.components.securitySchemes.PlatformSession.name =
						"caller_session";
				},
				unrelatedAnonymousAdmin: (value) => {
					value.paths["/api/v2/admin/agents"].get.security = [];
				},
			};
			for (const [name, mutate] of Object.entries(mutations)) {
				const candidate = structuredClone(current);
				mutate(candidate);
				const path = resolve(directory, `${name}.json`);
				await writeFile(path, JSON.stringify(candidate));
				expect(comparePaths(path, baseline).status, name).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("admits only the exact original binding addition and preserves every prior V3 operation", async () => {
		const artifact = fileURLToPath(
			new URL(
				"../artifacts/openapi/runtime-host.v3.openapi.json",
				import.meta.url,
			),
		);
		const current = JSON.parse(await readFile(artifact, "utf8"));
		const previous = structuredClone(current);
		delete previous.paths["/internal/runtime/v3/original-binding"];
		delete previous.components.schemas.RuntimeOriginalBindingResponseV3;
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-original-binding-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			expect(comparePaths(artifact, previousPath).status).toBe(0);
			const mutations: Record<string, (value: typeof current) => void> = {
				widenedRef: (value) => {
					value.components.schemas.RuntimeOriginalBindingResponseV3.properties.hostSessionRef.minLength = 0;
				},
				statusProjection: (value) => {
					value.components.schemas.RuntimeOriginalBindingResponseV3.properties.status =
						{ type: "string" };
				},
				changedRequest: (value) => {
					value.paths[
						"/internal/runtime/v3/original-binding"
					].post.requestBody.content["application/json"].schema.$ref =
						"#/components/schemas/RuntimeStopRequestV3";
				},
				anonymous: (value) => {
					value.paths["/internal/runtime/v3/original-binding"].post.security =
						[];
				},
				changedOldStatus: (value) => {
					value.paths["/internal/runtime/v3/status"].post.operationId =
						"changed";
				},
				changedOldRequest: (value) => {
					value.components.schemas.RuntimeStatusRequestV3.additionalProperties = true;
				},
			};
			for (const mutate of Object.values(mutations)) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(currentPath, JSON.stringify(changed));
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("admits the exact durable API Agent read audit action while preserving every old action and field", async () => {
		const artifact = fileURLToPath(
			new URL(
				"../artifacts/openapi/pilot-browser.v1.openapi.json",
				import.meta.url,
			),
		);
		const current = JSON.parse(await readFile(artifact, "utf8"));
		restorePreAgentApiManagementContract(current);
		restorePreRelayKeyContract(current);
		const previous = structuredClone(current);
		restoreOldApiReadActions(previous);
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-api-read-audit-compat-"),
		);
		const baseline = resolve(directory, "previous.json");
		const historicalCurrent = resolve(directory, "historical-current.json");
		try {
			await writeFile(baseline, JSON.stringify(previous));
			await writeFile(historicalCurrent, JSON.stringify(current));
			expect(comparePaths(historicalCurrent, baseline).status).toBe(0);
			for (const [name, mutate] of Object.entries({
				inventedAction: (value: typeof current) => {
					value.components.schemas.ScopedPlatformAuditActionV1.enum.push(
						"api.anything",
					);
				},
				removedOldAction: (value: typeof current) => {
					value.components.schemas.ScopedPlatformAuditActionV1.enum.shift();
				},
				credentialReadback: (value: typeof current) => {
					value.components.schemas.ScopedPlatformAuditProjectionV1.properties.credential =
						{ type: "string" };
				},
				anonymousAudit: (value: typeof current) => {
					value.paths["/api/v1/admin/audit"].get.security = [];
				},
			})) {
				const candidate = structuredClone(current);
				mutate(candidate);
				const path = resolve(directory, `${name}.json`);
				await writeFile(path, JSON.stringify(candidate));
				expect(comparePaths(path, baseline).status, name).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("admits only the exact administrator user governance addition", async () => {
		const artifact = fileURLToPath(
			new URL(
				"../artifacts/openapi/pilot-browser.v2.openapi.json",
				import.meta.url,
			),
		);
		const current = JSON.parse(await readFile(artifact, "utf8"));
		const previous = structuredClone(current);
		const governancePath = "/api/v2/admin/users/{userId}/disable";
		const governanceSchemas = [
			"PlatformUserDisableCommandV1",
			"PlatformUserDisableStatusV1",
			"PlatformUserDisableResultV1",
		];
		delete previous.paths[governancePath];
		for (const schema of governanceSchemas)
			delete previous.components.schemas[schema];
		for (const name of [
			"PlatformAuditProjectionV1",
			"PlatformAuditProjectionV2",
		]) {
			const subjectType =
				previous.components.schemas[name]?.properties?.subjectType?.enum;
			if (Array.isArray(subjectType))
				previous.components.schemas[name].properties.subjectType.enum =
					subjectType.filter((kind) => kind !== "user");
		}
		const actions =
			previous.components.schemas.ScopedPlatformAuditActionV1?.enum;
		if (Array.isArray(actions))
			previous.components.schemas.ScopedPlatformAuditActionV1.enum =
				actions.filter(
					(action) =>
						!["platform.user.disabled", "platform.user.reenabled"].includes(
							action,
						),
				);
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-governance-compat-"),
		);
		const baseline = resolve(directory, "previous.json");
		const candidate = resolve(directory, "candidate.json");
		try {
			await writeFile(baseline, JSON.stringify(previous));
			expect(comparePaths(artifact, baseline).status).toBe(0);
			const mutations: Record<string, (value: typeof current) => void> = {
				removedPut: (value) => {
					delete value.paths[governancePath].put;
				},
				changedRequest: (value) => {
					value.components.schemas.PlatformUserDisableCommandV1.properties.disabled =
						{
							type: "string",
						};
				},
				removedResult: (value) => {
					delete value.components.schemas.PlatformUserDisableResultV1;
				},
				changedDescription: (value) => {
					value.paths[governancePath].get.responses["200"].description =
						"changed";
				},
			};
			for (const [name, mutate] of Object.entries(mutations)) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(candidate, JSON.stringify(changed));
				expect(comparePaths(candidate, baseline).status, name).toBe(1);
			}
			const existing = structuredClone(current);
			const changedExisting = structuredClone(current);
			delete changedExisting.paths[governancePath].put;
			const existingPath = resolve(directory, "existing.json");
			await writeFile(existingPath, JSON.stringify(existing));
			await writeFile(candidate, JSON.stringify(changedExisting));
			expect(comparePaths(candidate, existingPath).status).toBe(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	// Keep every CLI comparison while bounding each baseline/version below one CI budget.
	it.each([
		["pinned", "historical"],
		["empty", "historical"],
		["empty", "latest"],
		["existingCookie", "historical"],
		["existingCookie", "latest"],
		["governance", "historical"],
		["governance", "latest"],
	] as const)(
		"admits only the pinned personal credential contract and rejects security/material regressions [%s/%s]",
		async (baselineKind, version) => {
			const artifact = fileURLToPath(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
			);
			const current = JSON.parse(await readFile(artifact, "utf8"));
			// This test isolates the credential compatibility contract. Skill Hub reads
			// have their own pinned-addition test below; keeping them out avoids paying
			// the subprocess cost for an unrelated contract mutation matrix.
			for (const path of [
				"/api/v2/skills",
				"/api/v2/skills/versions/{skillVersionId}",
				"/api/v2/agents/{agentId}/configuration/saved-model",
				"/api/v2/agents/{agentId}/default-relay-key/candidates",
			])
				delete current.paths[path];
			for (const name of [
				"SkillHubVersionMetadataV1",
				"SkillHubDirectoryPageV1",
				"AgentConfigurationUpdateRequestV4",
				"AgentDefaultRelayKeySavedCandidatesV1",
			])
				delete current.components.schemas[name];
			const latest = structuredClone(current);
			restorePreRelayKeyContract(current);
			const previous = structuredClone(current);
			for (const path of [
				"/api/v2/me/api-credentials",
				"/api/v2/me/api-credentials/{credentialId}",
			])
				delete previous.paths[path];
			for (const name of [
				"PersonalApiCredentialIssueRequestV1",
				"PersonalApiCredentialIssueResponseV1",
				"PersonalApiCredentialMetadataV1",
				"PersonalApiCredentialRevokeResponseV1",
			])
				delete previous.components.schemas[name];
			delete previous.components.securitySchemes;
			delete previous.paths["/api/v2/agents"].get.security;
			delete previous.paths["/api/v2/agents"].get.description;
			restoreOldApiReadActions(previous);
			const directory = await mkdtemp(
				resolve(tmpdir(), "agent-infra-personal-credential-compat-"),
			);
			const baseline = resolve(directory, "previous.json");
			const historicalCurrent = resolve(directory, "historical-current.json");
			const contractArtifact = resolve(directory, "skill-hub-stripped.json");
			try {
				await writeFile(baseline, JSON.stringify(previous));
				await writeFile(historicalCurrent, JSON.stringify(current));
				await writeFile(contractArtifact, JSON.stringify(current));
				const mutations: Record<string, (value: typeof current) => void> = {
					anonymous: (value) => {
						value.paths["/api/v2/me/api-credentials"].post.security = [];
					},
					bearerGovernance: (value) => {
						value.paths[
							"/api/v2/me/api-credentials/{credentialId}"
						].delete.security = [{ PersonalApiCredential: [] }];
					},
					hashReadback: (value) => {
						value.components.schemas.PersonalApiCredentialMetadataV1.properties.credentialHash =
							{ type: "string" };
					},
					emptyScopes: (value) => {
						value.components.schemas.PersonalApiCredentialIssueRequestV1.properties.scopes.minItems = 0;
					},
					materialReplay: (value) => {
						value.paths["/api/v2/me/api-credentials"].post.responses["200"] =
							value.paths["/api/v2/me/api-credentials"].post.responses["201"];
					},
					unexpectedPatch: (value) => {
						value.paths["/api/v2/me/api-credentials/{credentialId}"].patch =
							value.paths["/api/v2/me/api-credentials/{credentialId}"].delete;
					},
					differentCookie: (value) => {
						value.components.securitySchemes.PlatformSession.name =
							"caller_session";
					},
					unrelatedOperation: (value) => {
						value.paths["/unexpected"] =
							value.paths["/api/v2/me/api-credentials"];
					},
					oldAdministratorSecurity: (value) => {
						value.paths["/api/v2/admin/agents"].get.security = [];
					},
					oldMetadataResponse: (value) => {
						value.components.schemas.AgentProjectionV2.properties.rawCredential =
							{ type: "string" };
					},
					globalSecurity: (value) => {
						value.security = [{ PlatformSession: [] }];
					},
					anonymousAgentRead: (value) => {
						value.paths["/api/v2/agents"].get.security = [{}];
					},
					bearerOwnerOverride: (value) => {
						value.paths["/api/v2/agents"].get.parameters.find(
							({ name }: { name: string }) => name === "scope",
						).schema = { type: "string" };
					},
					bearerSchemeChanged: (value) => {
						value.components.securitySchemes.platformApiCredential = {
							type: "http",
							scheme: "basic",
						};
					},
					unrelatedBearerOperation: (value) => {
						value.paths["/api/v2/admin/agents"].get.security = [
							{ platformApiCredential: [] },
						];
					},
					andAuthentication: (value) => {
						value.paths["/api/v2/agents"].get.security = [
							{ PlatformSession: [], platformApiCredential: [] },
						];
					},
					removedBrowserAuthentication: (value) => {
						value.paths["/api/v2/agents"].get.security = [
							{ platformApiCredential: [] },
						];
					},
				};
				if (baselineKind === "pinned") {
					expect(comparePaths(historicalCurrent, baseline).status).toBe(0);
					for (const [name, mutate] of Object.entries(mutations)) {
						const candidate = structuredClone(current);
						mutate(candidate);
						const path = resolve(directory, `${name}.json`);
						await writeFile(path, JSON.stringify(candidate));
						const result = comparePaths(path, baseline);
						expect(result.status, name).toBe(1);
						expect(result.stderr, name).toContain("changed OpenAPI contract");
					}
				} else {
					const existing = structuredClone(
						baselineKind === "governance" ? current : previous,
					);
					if (baselineKind === "governance") {
						delete existing.paths["/api/v2/agents"].get.security;
						delete existing.paths["/api/v2/agents"].get.description;
						delete existing.components.securitySchemes.platformApiCredential;
						restoreOldApiReadActions(existing);
					} else {
						existing.components.securitySchemes = {};
					}
					if (baselineKind === "existingCookie")
						existing.components.securitySchemes.PlatformSession =
							structuredClone(
								current.components.securitySchemes.PlatformSession,
							);
					const path = resolve(directory, `${baselineKind}-previous.json`);
					await writeFile(path, JSON.stringify(existing));
					if (version === "historical") {
						if (baselineKind === "governance")
							expect(comparePaths(path, baseline).status).toBe(0);
						expect(
							comparePaths(contractArtifact, path).status,
							baselineKind,
						).toBe(0);
						expect(
							comparePaths(historicalCurrent, path).status,
							`${baselineKind}-historical`,
						).toBe(0);
					}
					for (const [name, mutate] of Object.entries(mutations)) {
						const candidate = structuredClone(
							version === "historical" ? current : latest,
						);
						mutate(candidate);
						const mutated = resolve(
							directory,
							`${baselineKind}-${version}-${name}.json`,
						);
						await writeFile(mutated, JSON.stringify(candidate));
						expect(
							comparePaths(mutated, path).status,
							`${baselineKind}-${version}-${name}`,
						).toBe(1);
					}
				}
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
		60_000,
	);
	it("tracks published browser, file, readiness and template-release contracts", async () => {
		const source = await readFile(cliPath, "utf8");
		for (const path of [
			"json-schema/files.v1.schema.json",
			"openapi/files.v1.openapi.json",
			"json-schema/runtime-readiness.v1.schema.json",
			"openapi/runtime-readiness.v1.openapi.json",
			"openapi/standard-template-release.v1.openapi.json",
		])
			expect(source).toContain(`"packages/contracts/artifacts/${path}"`);
		expect(source).toContain(
			'"packages/contracts/artifacts/openapi/pilot-browser.v1.openapi.json"',
		);
		expect(source).toContain(
			'"packages/contracts/artifacts/openapi/pilot-browser.v2.openapi.json"',
		);
	});

	it("accepts additive schemas and disjoint oneOf literals", () => {
		const result = compare("additive");
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});

	it("accepts only the model-selection fallback OpenAPI addition", () => {
		const result = compare(
			"openapi-component-ref-additive",
			"openapi-component-ref-base",
		);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});

	it("admits only the pinned requested-model fallback V2 event in V2 histories (#2908)", async () => {
		type Schema = Record<string, unknown>;
		const isFallbackV2 = (value: unknown) => {
			const schema = value as {
				$ref?: string;
				properties?: {
					type?: { const?: string };
					schemaVersion?: { const?: number };
				};
			};
			return (
				schema?.$ref === "#/components/schemas/ModelSelectionFallbackEventV2" ||
				(schema?.properties?.type?.const === "model.selection.fell_back" &&
					schema.properties.schemaVersion?.const === 2)
			);
		};
		const strip = (value: unknown): unknown =>
			Array.isArray(value)
				? value.filter((item) => !isFallbackV2(item)).map(strip)
				: value !== null && typeof value === "object"
					? Object.fromEntries(
							Object.entries(value).map(([key, item]) => [key, strip(item)]),
						)
					: value;
		const directory = await mkdtemp(resolve(tmpdir(), "agent-infra-2908-"));
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			for (const version of ["v1", "v2"] as const) {
				const current = JSON.parse(
					await readFile(
						new URL(
							`../artifacts/openapi/pilot-browser.${version}.openapi.json`,
							import.meta.url,
						),
						"utf8",
					),
				);
				const previous = structuredClone(current);
				const previousSchemas = previous.components.schemas as Record<
					string,
					Schema
				>;
				delete previousSchemas.ModelSelectionFallbackEventV2;
				for (const name of [
					"PersistedConversationEventV2",
					"TaskProjectionV1",
					"TaskSseMessageV1",
				])
					if (previousSchemas[name])
						previousSchemas[name] = strip(previousSchemas[name]) as Schema;
				// 基线确实缺少该事件，当前产物只在既定宿主中新增它。
				expect(JSON.stringify(previous)).not.toBe(JSON.stringify(current));
				await writeFile(previousPath, JSON.stringify(previous));
				await writeFile(currentPath, JSON.stringify(current));
				expect(comparePaths(currentPath, previousPath).status).toBe(0);
				const fallback = (document: typeof current) => {
					const component =
						document.components.schemas.ModelSelectionFallbackEventV2;
					if (component) return component;
					const host = document.components.schemas.TaskProjectionV1;
					return host.properties.events.items.anyOf[0].anyOf.find(isFallbackV2);
				};
				for (const mutate of [
					(document: typeof current) => {
						fallback(document).properties.payload.properties.requestedModelId =
							{
								type: "string",
							};
					},
					(document: typeof current) => {
						fallback(document).properties.payload.required = fallback(
							document,
						).properties.payload.required.filter(
							(name: string) => name !== "requestedModelDisplayName",
						);
					},
					(document: typeof current) => {
						fallback(document).properties.payload.additionalProperties = true;
					},
					(document: typeof current) => {
						delete fallback(document).properties.payload.properties
							.requestedModelDisplayName.anyOf[0].maxLength;
					},
					(document: typeof current) => {
						// 新增事件不能借道其他 Schema 出现。
						document.components.schemas.SseEventIdV1 = {
							anyOf: [
								document.components.schemas.SseEventIdV1,
								structuredClone(fallback(document)),
							],
						};
					},
					(document: typeof current) => {
						document.components.schemas.ModelSelectionFallbackEventV1.properties.payload.properties.requestedModelOptionId =
							{ type: "string" };
					},
				]) {
					const changed = structuredClone(current);
					mutate(changed);
					await writeFile(currentPath, JSON.stringify(changed));
					expect(comparePaths(currentPath, previousPath).status).toBe(1);
				}
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("admits only the pinned reasoning events in their reviewed hosts (#2979)", async () => {
		type Schema = Record<string, unknown>;
		type Document = { components: { schemas: Record<string, Schema> } };
		const persisted = {
			$ref: "#/components/schemas/PersistedConversationEventV2",
		};
		const cases = [
			{
				artifact: "runtime-host.v3",
				name: "RuntimeReasoningEventV2",
				unionHosts: ["RuntimeEvent"],
				itemHosts: [] as string[],
			},
			{
				artifact: "pilot-browser.v2",
				name: "ReasoningDeltaEventV2",
				unionHosts: ["ConversationSseMessageV2"],
				itemHosts: [
					"ConversationDetailProjectionV2",
					"ExecutionDetailProjectionV2",
				],
			},
		];
		// 独立实现的反向变换：去掉新增 Schema，把宿主还原为基线形状。
		const collapse = (value: unknown, ref: string): unknown => {
			if (
				JSON.stringify(value) ===
				JSON.stringify({ anyOf: [persisted, { $ref: ref }] })
			)
				return structuredClone(persisted);
			if (Array.isArray(value)) return value.map((item) => collapse(item, ref));
			if (value !== null && typeof value === "object")
				return Object.fromEntries(
					Object.entries(value).map(([key, item]) => [
						key,
						collapse(item, ref),
					]),
				);
			return value;
		};
		const directory = await mkdtemp(resolve(tmpdir(), "agent-infra-2979-"));
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			for (const item of cases) {
				const ref = `#/components/schemas/${item.name}`;
				const current = JSON.parse(
					await readFile(
						new URL(
							`../artifacts/openapi/${item.artifact}.openapi.json`,
							import.meta.url,
						),
						"utf8",
					),
				) as Document;
				const previous = structuredClone(current);
				const schemas = previous.components.schemas;
				delete schemas[item.name];
				for (const host of item.unionHosts) {
					const options = schemas[host]?.anyOf as Schema[];
					schemas[host] = {
						...schemas[host],
						anyOf: options.filter((option) => option.$ref !== ref),
					};
				}
				for (const host of item.itemHosts)
					schemas[host] = collapse(schemas[host], ref) as Schema;
				// 基线确实缺少该事件，且反向变换后不再引用它。
				expect(JSON.stringify(previous)).not.toContain(JSON.stringify(ref));
				await writeFile(previousPath, JSON.stringify(previous));
				await writeFile(currentPath, JSON.stringify(current));
				expect(comparePaths(currentPath, previousPath).status).toBe(0);
				const component = (document: Document) =>
					document.components.schemas[item.name] as {
						properties: {
							payload: {
								properties: Record<string, Schema>;
								additionalProperties?: boolean;
							};
						};
					};
				const textField =
					item.name === "RuntimeReasoningEventV2" ? "delta" : "text";
				for (const mutate of [
					(document: Document) => {
						component(document).properties.payload.properties.encrypted = {
							type: "string",
						};
					},
					(document: Document) => {
						component(document).properties.payload.properties.kind = {
							enum: ["raw", "summary", "encrypted"],
							type: "string",
						};
					},
					(document: Document) => {
						component(document).properties.payload.additionalProperties = true;
					},
					(document: Document) => {
						const field =
							component(document).properties.payload.properties[textField];
						if (field) delete field.minLength;
					},
					(document: Document) => {
						// 宿主缺少新增选项时不放行未被引用的新 Schema。
						const host = document.components.schemas[
							item.unionHosts[0] as string
						] as { anyOf: Schema[] };
						host.anyOf = host.anyOf.filter((option) => option.$ref !== ref);
					},
					(document: Document) => {
						// 新增事件不能借道其他 Schema 出现。
						const other =
							item.name === "RuntimeReasoningEventV2"
								? "RuntimeEventV2"
								: "SseEventIdV1";
						document.components.schemas[other] = {
							anyOf: [document.components.schemas[other], { $ref: ref }],
						};
					},
				]) {
					const changed = structuredClone(current);
					mutate(changed);
					await writeFile(currentPath, JSON.stringify(changed));
					expect(comparePaths(currentPath, previousPath).status).toBe(1);
				}
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("admits only the pinned sandbox result-file additions in their reviewed hosts (#3226)", async () => {
		type Schema = Record<string, unknown> & {
			$ref?: string;
			properties?: Record<string, Schema>;
			required?: string[];
			additionalProperties?: boolean;
			anyOf?: Schema[];
			oneOf?: Schema[];
			const?: unknown;
		};
		type Document = { components: { schemas: Record<string, Schema> } };
		const events = [
			{ name: "ResultFileEventV2", type: "result.file" },
			{ name: "RuntimeFileEventV2", type: "file" },
		];
		const isEvent = (value: Schema) =>
			events.some(
				({ name, type }) =>
					value.$ref === `#/components/schemas/${name}` ||
					(value.properties?.type?.const === type &&
						value.properties?.schemaVersion?.const === 2 &&
						value.properties?.payload?.properties?.workspaceReference !==
							undefined),
			);
		const isResultExchange = (value: Schema) =>
			value.properties?.operation?.const === "result" &&
			value.properties?.schemaVersion?.const === 2 &&
			value.properties?.executionGrant !== undefined;
		// 独立实现的反向变换：去掉新增事件与结果请求上的新字段，得到基线形状。
		const strip = (value: unknown): unknown => {
			if (Array.isArray(value))
				return value
					.filter((item) => !isEvent(item as Schema))
					.map((item) => strip(item));
			if (value === null || typeof value !== "object") return value;
			const copy = Object.fromEntries(
				Object.entries(value).map(([key, item]) => [key, strip(item)]),
			) as Schema;
			if (isResultExchange(copy) && copy.properties)
				delete copy.properties.workspaceReference;
			return copy;
		};
		const find = (
			value: unknown,
			predicate: (schema: Schema) => boolean,
		): Schema | undefined => {
			if (value === null || typeof value !== "object") return undefined;
			if (!Array.isArray(value) && predicate(value as Schema))
				return value as Schema;
			for (const item of Object.values(value)) {
				const found = find(item, predicate);
				if (found) return found;
			}
			return undefined;
		};
		const event = (document: Document) =>
			find(
				document.components.schemas,
				(schema) => schema.$ref === undefined && isEvent(schema),
			);
		const exchange = (document: Document) =>
			find(document.components.schemas, isResultExchange);
		const payload = (document: Document) => {
			const value = event(document)?.properties?.payload;
			if (!value) throw new Error("result-file event missing");
			return value as Schema & {
				properties: Record<string, Schema>;
				required: string[];
			};
		};
		const directory = await mkdtemp(resolve(tmpdir(), "agent-infra-3226-"));
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			for (const artifact of [
				"files.v1",
				"pilot-browser.v1",
				"pilot-browser.v2",
				"runtime-host.v3",
				"runtime-host.v4",
			]) {
				const current = JSON.parse(
					await readFile(
						new URL(
							`../artifacts/openapi/${artifact}.openapi.json`,
							import.meta.url,
						),
						"utf8",
					),
				) as Document;
				const previous = strip(current) as Document;
				for (const { name } of events) delete previous.components.schemas[name];
				// 基线确实缺少新增，反向变换后不再出现工作区引用。
				expect(JSON.stringify(previous), artifact).not.toContain(
					"workspaceReference",
				);
				await writeFile(previousPath, JSON.stringify(previous));
				await writeFile(currentPath, JSON.stringify(current));
				expect(comparePaths(currentPath, previousPath).status, artifact).toBe(
					0,
				);
				const mutations: ((document: Document) => void)[] = [];
				if (event(current))
					mutations.push(
						(document) => {
							payload(document).properties.path = { type: "string" };
						},
						(document) => {
							payload(document).additionalProperties = true;
						},
						(document) => {
							payload(document).required = payload(document).required.filter(
								(field) => field !== "workspaceReference",
							);
						},
						(document) => {
							const reference = payload(document).properties
								.workspaceReference as { anyOf: Schema[] };
							delete reference.anyOf[0]?.pattern;
						},
						(document) => {
							// 新增事件不能借道其他 Schema 出现。
							const clone = structuredClone(event(document));
							const other =
								document.components.schemas.SseEventIdV1 !== undefined
									? "SseEventIdV1"
									: "OpaqueIdV1";
							document.components.schemas[other] = {
								anyOf: [
									document.components.schemas[other] ?? { type: "string" },
									clone as Schema,
								],
							};
						},
					);
				if (exchange(current))
					mutations.push(
						(document) => {
							exchange(document)?.required?.push("workspaceReference");
						},
						(document) => {
							const reference = exchange(document)?.properties
								?.workspaceReference as { anyOf: Schema[] };
							delete reference.anyOf[0]?.maxLength;
						},
						(document) => {
							// 新字段只属于结果请求，不能出现在读取请求上。
							const read = find(
								document.components.schemas,
								(schema) =>
									schema.properties?.operation?.const === "read" &&
									schema.properties?.schemaVersion?.const === 2,
							);
							if (!read?.properties) throw new Error("read request missing");
							read.properties.workspaceReference = structuredClone(
								exchange(document)?.properties?.workspaceReference,
							) as Schema;
						},
					);
				expect(mutations.length, artifact).toBeGreaterThan(0);
				for (const [index, mutate] of mutations.entries()) {
					const changed = structuredClone(current);
					mutate(changed);
					await writeFile(currentPath, JSON.stringify(changed));
					expect(
						comparePaths(currentPath, previousPath).status,
						`${artifact} mutation ${index}`,
					).toBe(1);
				}
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}, 30_000);

	it("accepts only the reviewed custom Agent model selection additions", async () => {
		type OpenApiDocument = {
			components: {
				schemas: Record<string, Record<string, unknown>>;
			};
			paths: Record<string, { get?: unknown }>;
		};
		const cases = [
			{
				name: "runtime-host.v1.openapi.json",
				remove(value: OpenApiDocument) {
					delete value.components.schemas.RuntimeModelDirectoryRequestV1;
					delete value.components.schemas
						.RuntimeModelDirectoryDispatchRequestV1;
					delete value.components.schemas.RuntimeModelDirectoryResponseV1;
					const schema = value.components.schemas.ExecutionGrantCommandV1;
					if (!schema) throw new Error("ExecutionGrantCommandV1 missing");
					const commands = schema.enum as string[];
					schema.enum = commands.filter(
						(command) => command !== "model-directory.read",
					);
				},
			},
			{
				name: "pilot-delegated.v1.openapi.json",
				remove(value: OpenApiDocument) {
					const schema = value.components.schemas.ExecutionGrantCommandV1;
					if (!schema) throw new Error("ExecutionGrantCommandV1 missing");
					const commands = schema.enum as string[];
					schema.enum = commands.filter(
						(command) => command !== "model-directory.read",
					);
				},
			},
			{
				name: "pilot-browser.v1.openapi.json",
				remove(value: OpenApiDocument) {
					const path =
						value.paths[
							"/api/v1/conversations/{conversationId}/model-selection"
						];
					if (!path) throw new Error("model-selection path missing");
					delete path.get;
					delete value.components.schemas
						.ConversationModelSelectionProjectionV1;
				},
			},
		] as const;
		const directory = await mkdtemp(resolve(tmpdir(), "custom-agent-compat-"));
		try {
			for (const entry of cases) {
				const current = JSON.parse(
					await readFile(
						new URL(`../artifacts/openapi/${entry.name}`, import.meta.url),
						"utf8",
					),
				);
				const previous = structuredClone(current);
				entry.remove(previous);
				const previousPath = resolve(directory, `previous-${entry.name}`);
				const currentPath = resolve(directory, `current-${entry.name}`);
				await writeFile(previousPath, JSON.stringify(previous));
				await writeFile(currentPath, JSON.stringify(current));
				expect(comparePaths(currentPath, previousPath).status).toBe(0);
				const altered = structuredClone(current);
				if (entry.name === "runtime-host.v1.openapi.json") {
					altered.components.schemas.RuntimeModelDirectoryResponseV1.properties.options.maxItems = 63;
				} else if (entry.name === "pilot-browser.v1.openapi.json") {
					altered.components.schemas.ConversationModelSelectionProjectionV1.properties.available.type =
						"string";
				} else {
					altered.components.schemas.ExecutionGrantCommandV1.enum =
						altered.components.schemas.ExecutionGrantCommandV1.enum.filter(
							(value: string) => value !== "turn.submit",
						);
				}
				await writeFile(currentPath, JSON.stringify(altered));
				expect(comparePaths(currentPath, previousPath).status, entry.name).toBe(
					1,
				);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("accepts the additive server-resolved Connection capability", async () => {
		const current = JSON.parse(
			await readFile(pilotBrowserArtifactPath, "utf8"),
		);
		const previous = structuredClone(current);
		expect(previous.paths["/api/v1/connection/capability"]).toBeDefined();
		delete previous.paths["/api/v1/connection/capability"];
		delete previous.components.schemas.ConnectionCapabilityProjectionV1;
		expect(previous).not.toEqual(current);
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-connection-capability-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			const result = comparePaths(currentPath, previousPath);
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("rejects capability mutations and unrelated contract changes", async () => {
		const current = JSON.parse(
			await readFile(pilotBrowserArtifactPath, "utf8"),
		);
		const previous = structuredClone(current);
		delete previous.paths["/api/v1/connection/capability"];
		delete previous.components.schemas.ConnectionCapabilityProjectionV1;
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-capability-guard-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			for (const mutate of [
				(value: typeof current) => {
					value.paths["/api/v1/connection/capability"].get.security = [];
				},
				(value: typeof current) => {
					value.components.schemas.ConnectionCapabilityProjectionV1 = {
						type: "object",
					};
				},
				(value: typeof current) => {
					delete value.paths["/api/v1/session"];
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				expect(changed).not.toEqual(current);
				await writeFile(currentPath, JSON.stringify(changed));
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("rejects every deviation from the fallback OpenAPI addition", async () => {
		const previous = fixturePath("openapi-component-ref-base");
		const additive = JSON.parse(
			await readFile(fixturePath("openapi-component-ref-additive"), "utf8"),
		);
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-openapi-ref-"),
		);
		const expectRejected = async (name: string, current: unknown) => {
			const path = resolve(directory, `${name}.json`);
			await writeFile(path, JSON.stringify(current), "utf8");
			const result = comparePaths(path, previous);
			expect(result.status, name).toBe(1);
			expect(result.stderr, name).toContain("changed OpenAPI contract");
		};

		try {
			for (const [name, ref] of [
				["alternate", "#/components/schemas/OtherEventV1"],
				["external", "https://example.invalid/FallbackEventV1"],
			] as const) {
				const current = structuredClone(additive);
				current.components.schemas.PersistedConversationEventV1.oneOf[1].$ref =
					ref;
				await expectRejected(name, current);
			}

			const missingRef = structuredClone(additive);
			delete missingRef.components.schemas.PersistedConversationEventV1.oneOf[1]
				.$ref;
			await expectRejected("missing-ref", missingRef);

			const sibling = structuredClone(additive);
			sibling.components.schemas.PersistedConversationEventV1.oneOf[1].description =
				"Ref sibling";
			await expectRejected("sibling", sibling);

			const wrongReason = structuredClone(additive);
			wrongReason.components.schemas.ModelSelectionFallbackEventV1.properties.payload.properties.reason.const =
				"provider_failed";
			await expectRejected("wrong-reason", wrongReason);

			const extraPayload = structuredClone(additive);
			const extra =
				extraPayload.components.schemas.ModelSelectionFallbackEventV1.properties
					.payload;
			extra.properties.credential = { type: "string" };
			extra.required.push("credential");
			await expectRejected("extra-payload", extraPayload);

			const operationChange = structuredClone(additive);
			operationChange.paths["/events"].get.operationId = "streamEventsV2";
			await expectRejected("operation", operationChange);

			const discriminatorOverlap = structuredClone(additive);
			const discriminator =
				discriminatorOverlap.components.schemas.PersistedConversationEventV1
					.oneOf[0].properties.type;
			delete discriminator.const;
			discriminator.enum = ["text.delta", "model.selection.fell_back"];
			await expectRejected("existing-discriminator", discriminatorOverlap);

			const removedRequired = structuredClone(additive);
			removedRequired.components.schemas.PersistedConversationEventV1.oneOf[0].required =
				["type"];
			await expectRejected("existing-required", removedRequired);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("accepts only the agent-summary OpenAPI addition", async () => {
		const current = JSON.parse(
			await readFile(pilotBrowserArtifactPath, "utf8"),
		);
		const options = current.components.schemas.ExecutionProcessSummaryV1.oneOf;
		const summaryIndex = options.findIndex(
			(option: { properties?: { kind?: { const?: string } } }) =>
				option.properties?.kind?.const === "agent_summary",
		);
		expect(summaryIndex).toBeGreaterThanOrEqual(0);
		const previous = structuredClone(current);
		previous.components.schemas.ExecutionProcessSummaryV1.oneOf.splice(
			summaryIndex,
			1,
		);
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-agent-summary-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const expectResult = async (
			name: string,
			candidate: unknown,
			status: number,
		) => {
			const currentPath = resolve(directory, `${name}.json`);
			await Promise.all([
				writeFile(previousPath, JSON.stringify(previous), "utf8"),
				writeFile(currentPath, JSON.stringify(candidate), "utf8"),
			]);
			const result = comparePaths(currentPath, previousPath);
			expect(result.status, name).toBe(status);
			if (status === 0) {
				expect(result.stderr, name).toBe("");
			} else {
				expect(result.stderr, name).toContain("changed OpenAPI contract");
			}
		};

		try {
			await expectResult("additive", current, 0);

			const wrongCategory = structuredClone(current);
			wrongCategory.components.schemas.ExecutionProcessSummaryV1.oneOf[
				summaryIndex
			].properties.category.enum.push("credential");
			await expectResult("wrong-category", wrongCategory, 1);

			const extraField = structuredClone(current);
			extraField.components.schemas.ExecutionProcessSummaryV1.oneOf[
				summaryIndex
			].properties.credential = { type: "string" };
			await expectResult("extra-field", extraField, 1);

			const operationChange = structuredClone(current);
			operationChange.info.title = "changed";
			await expectResult("other-change", operationChange, 1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("admits only WeCom receipt and setup routes and preserves existing browser authority", async () => {
		const current = JSON.parse(
			await readFile(pilotBrowserArtifactPath, "utf8"),
		);
		// #440 的历史新增按 #3184 之前的回执状态枚举核对。
		restorePreWecomMediaRejectionContract(current);
		restorePreWecomNewConversationContract(current);
		const paths = [
			"/api/v1/wecom/receipts",
			"/api/v1/wecom/receipts/{receiptId}",
			"/api/v1/wecom/receipts/{receiptId}/abandon",
			"/api/v1/agents/{agentId}/wecom-bot",
			"/api/v1/agents/{agentId}/wecom-setup",
			"/api/v1/agents/{agentId}/wecom-setup/{sessionId}",
			"/api/v1/agents/{agentId}/wecom-setup/{sessionId}/credentials",
			"/api/v1/agents/{agentId}/wecom-setup/{sessionId}/cancel",
			"/api/v1/agents/{agentId}/wecom-app",
			"/api/v1/agents/{agentId}/wecom-app-setup",
			"/api/v1/agents/{agentId}/wecom-app-setup/{sessionId}",
			"/api/v1/agents/{agentId}/wecom-app-setup/{sessionId}/credentials",
			"/api/v1/agents/{agentId}/wecom-app-setup/{sessionId}/cancel",
		] as const;
		const previous = structuredClone(current);
		for (const path of paths) delete previous.paths[path];
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-wecom-compatibility-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);

			// The pre-QR #440 receipt artifact remains a valid historical
			// compatibility pair after the current route hash changed.
			const legacyCurrent = structuredClone(current);
			const setupSchema =
				legacyCurrent.paths["/api/v1/agents/{agentId}/wecom-setup"].post
					.responses["200"].content["application/json"].schema;
			legacyCurrent.paths[
				"/api/v1/agents/{agentId}/wecom-setup"
			].post.responses["200"].content["application/json"].schema =
				structuredClone(setupSchema.oneOf[0]);
			const legacyPrevious = structuredClone(legacyCurrent);
			for (const path of paths.slice(0, 8)) delete legacyPrevious.paths[path];
			await writeFile(previousPath, JSON.stringify(legacyPrevious));
			await writeFile(currentPath, JSON.stringify(legacyCurrent));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);

			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			const mutations = [
				(document: typeof current) => {
					delete document.paths[paths[0]];
				},
				(document: typeof current) => {
					document.paths[paths[2]].post.operationId = "retryDelivery";
				},
				(document: typeof current) => {
					document.paths[paths[6]].post.requestBody = {};
				},
				(document: typeof current) => {
					document.paths[paths[0]].get.responses = {};
				},
				(document: typeof current) => {
					delete document.paths["/api/v1/agents"];
				},
				(document: typeof current) => {
					document.components.schemas = {};
				},
			];
			for (const mutate of mutations) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(currentPath, JSON.stringify(changed));
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("admits only the exact QR response branch and preserves the legacy branch", async () => {
		const current = JSON.parse(
			await readFile(pilotBrowserArtifactPath, "utf8"),
		);
		const path = "/api/v1/agents/{agentId}/wecom-setup";
		const schema =
			current.paths[path].post.responses["200"].content["application/json"]
				.schema;
		const previous = structuredClone(current);
		previous.paths[path].post.responses["200"].content[
			"application/json"
		].schema = structuredClone(schema.oneOf[0]);
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-wecom-qr-compatibility-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);

			const mutations: Array<[string, (document: typeof current) => void]> = [
				[
					"removed legacy branch",
					(document) =>
						document.paths[path].post.responses["200"].content[
							"application/json"
						].schema.oneOf.splice(0, 1),
				],
				[
					"changed legacy required fields",
					(document) => {
						const required =
							document.paths[path].post.responses["200"].content[
								"application/json"
							].schema.oneOf[0].required;
						required.splice(required.indexOf("sessionId"), 1);
					},
				],
				[
					"changed QR field",
					(document) => {
						document.paths[path].post.responses["200"].content[
							"application/json"
						].schema.oneOf[1].properties.qr.properties.authorizationUrl.format =
							"uri-reference";
					},
				],
				[
					"added secret field",
					(document) => {
						document.paths[path].post.responses["200"].content[
							"application/json"
						].schema.oneOf[1].properties.secret = { type: "string" };
					},
				],
				[
					"added unapproved branch",
					(document) => {
						document.paths[path].post.responses["200"].content[
							"application/json"
						].schema.oneOf.push({
							type: "object",
							additionalProperties: false,
							properties: { unauthorized: { const: true } },
							required: ["unauthorized"],
						});
					},
				],
				[
					"changed route security",
					(document) => {
						document.paths[path].post.security = [{ PlatformSession: [] }];
					},
				],
			];
			for (const [name, mutate] of mutations) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(currentPath, JSON.stringify(changed));
				expect(comparePaths(currentPath, previousPath).status, name).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("accepts only the Runtime status-recovery V2 addition", async () => {
		const current = JSON.parse(
			await readFile(runtimeHostV2ArtifactPath, "utf8"),
		);
		const previous = structuredClone(current);
		delete previous.paths["/internal/runtime/v2/status"];
		delete previous.components.schemas.RuntimeStatusRequestV2;
		delete previous.components.schemas.RuntimeStatusResponseV2;
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-runtime-status-recovery-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await Promise.all([
				writeFile(previousPath, JSON.stringify(previous), "utf8"),
				writeFile(currentPath, JSON.stringify(current), "utf8"),
			]);
			expect(comparePaths(currentPath, previousPath).status).toBe(0);

			const changed = structuredClone(current);
			changed.components.schemas.RuntimeStatusRequestV2.properties.recovery.properties.schemaVersion.const = 2;
			await writeFile(currentPath, JSON.stringify(changed), "utf8");
			expect(comparePaths(currentPath, previousPath).status).toBe(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each([
		["RUNTIME_SESSION_BLOCKED", "#3017"],
		["RUNTIME_FILE_INPUT_REJECTED", "#3314"],
	])(
		"admits only the pinned %s rejected result in submit V2+ unions (%s)",
		async (code) => {
			type Union = Array<{ properties?: Record<string, { const?: unknown }> }>;
			type Document = {
				components: { schemas: Record<string, Record<string, unknown>> };
			};
			const blocked = (option: Union[number]) =>
				option?.properties?.code?.const === code;
			const unions = (value: Document) => {
				const schemas = value.components.schemas as Record<
					string,
					{ anyOf?: Union; properties?: { result?: { anyOf?: Union } } }
				>;
				return [
					schemas.RuntimeOperationResultV2?.anyOf,
					schemas.RuntimeOperationResponseV3?.properties?.result?.anyOf,
					schemas.RuntimeOperationResponseV4?.properties?.result?.anyOf,
					schemas.RuntimeOperationResponseV5?.properties?.result?.anyOf,
				].filter((union): union is Union => Array.isArray(union));
			};
			// 还原新增该成员之前的基线：从每个 V2+ 结果联合中删除它。
			const restorePreSessionBlockedContract = (value: Document) => {
				for (const union of unions(value)) {
					const index = union.findIndex(blocked);
					if (index !== -1) union.splice(index, 1);
				}
			};
			const directory = await mkdtemp(
				resolve(tmpdir(), "agent-infra-runtime-session-blocked-"),
			);
			const previousPath = resolve(directory, "previous.json");
			const currentPath = resolve(directory, "current.json");
			try {
				for (const version of ["v2", "v3", "v4", "v5"]) {
					const current = JSON.parse(
						await readFile(
							new URL(
								`../artifacts/openapi/runtime-host.${version}.openapi.json`,
								import.meta.url,
							),
							"utf8",
						),
					) as Document;
					const [union] = unions(current);
					expect(union?.filter(blocked)).toHaveLength(1);
					const previous = structuredClone(current);
					restorePreSessionBlockedContract(previous);
					await Promise.all([
						writeFile(previousPath, JSON.stringify(previous), "utf8"),
						writeFile(currentPath, JSON.stringify(current), "utf8"),
					]);
					expect(comparePaths(currentPath, previousPath).status).toBe(0);
					const member = (value: Document) => {
						const found = unions(value)[0]?.find(blocked);
						if (!found?.properties) throw new Error("blocked member missing");
						return found as {
							properties: {
								message: { const: unknown };
								retryable: { const: unknown };
								detail?: unknown;
							};
							required: string[];
						};
					};
					for (const mutate of [
						// 消息与可重试性逐字段固定。
						(value: Document) => {
							member(value).properties.message.const = "Runtime is blocked";
						},
						(value: Document) => {
							member(value).properties.retryable.const = true;
						},
						// 不能借机新增字段或放松必填。
						(value: Document) => {
							member(value).properties.detail = { type: "string" };
						},
						(value: Document) => {
							member(value).required = ["outcome", "code"];
						},
						// 同一联合中只能新增一个成员。
						(value: Document) => {
							const target = unions(value)[0];
							const found = target?.find(blocked);
							if (found) target?.push(structuredClone(found));
						},
						// 其他既有成员不能同时变化。
						(value: Document) => {
							const target = unions(value)[0];
							const index =
								target?.findIndex(
									(option) =>
										option?.properties?.code?.const ===
										"RUNTIME_TURN_NOT_ACTIVE",
								) ?? -1;
							target?.splice(index, 1);
						},
					]) {
						const changed = structuredClone(current);
						mutate(changed);
						await writeFile(currentPath, JSON.stringify(changed), "utf8");
						const result = comparePaths(currentPath, previousPath);
						expect(result.status).toBe(1);
						expect(result.stderr).toContain("changed OpenAPI contract");
					}
				}

				// submit V1 的结果枚举不扩展：同一成员加入 V1 结果仍为 breaking。
				const v1 = JSON.parse(
					await readFile(
						new URL(
							"../artifacts/openapi/runtime-host.v1.openapi.json",
							import.meta.url,
						),
						"utf8",
					),
				) as Document;
				const v2 = JSON.parse(
					await readFile(runtimeHostV2ArtifactPath, "utf8"),
				) as Document;
				const v1Options = (
					v1.components.schemas.RuntimeOperationResultV1 as { oneOf?: Union }
				).oneOf;
				const v2Member = unions(v2)[0]?.find(blocked);
				if (!v1Options || !v2Member)
					throw new Error("runtime host V1 result fixture missing");
				const widenedV1 = structuredClone(v1);
				(
					widenedV1.components.schemas.RuntimeOperationResultV1 as {
						oneOf: Union;
					}
				).oneOf.push(structuredClone(v2Member));
				await Promise.all([
					writeFile(previousPath, JSON.stringify(v1), "utf8"),
					writeFile(currentPath, JSON.stringify(widenedV1), "utf8"),
				]);
				const widened = comparePaths(currentPath, previousPath);
				expect(widened.status).toBe(1);
				expect(widened.stderr).toContain("changed OpenAPI contract");
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	);

	it("admits only the pinned administrator Agent read and preserves every existing contract", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const path = "/api/v2/admin/agents";
		const previous = structuredClone(current);
		delete previous.paths[path];
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-admin-read-v2-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			for (const [name, mutate] of [
				[
					"operation",
					(document: typeof current) => {
						document.paths[path].get.operationId = "unreviewed";
					},
				],
				[
					"query",
					(document: typeof current) => {
						document.paths[path].get.parameters = [];
					},
				],
				[
					"response",
					(document: typeof current) => {
						document.paths[path].get.responses["200"].content[
							"application/json"
						].schema.required = [];
					},
				],
				[
					"operation-security",
					(document: typeof current) => {
						document.paths[path].get.security = [];
					},
				],
				[
					"document-security",
					(document: typeof current) => {
						document.security = [];
					},
				],
				[
					"old-operation",
					(document: typeof current) => {
						document.paths["/api/v2/agents"].get.operationId = "unreviewed";
					},
				],
				[
					"old-component",
					(document: typeof current) => {
						document.components.schemas.AgentProjectionV2.required = [];
					},
				],
				[
					"old-security",
					(document: typeof current) => {
						document.components.securitySchemes = {};
					},
				],
				[
					"extra-path",
					(document: typeof current) => {
						document.paths["/api/v2/admin/unreviewed"] = {};
					},
				],
				[
					"extra-method",
					(document: typeof current) => {
						document.paths[path].post = document.paths[path].get;
					},
				],
			] as const) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(currentPath, JSON.stringify(changed));
				const result = comparePaths(currentPath, previousPath);
				expect(result.status, name).toBe(1);
				expect(result.stderr, name).toContain("changed OpenAPI contract");
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("admits only the exact application issuer addition and preserves existing authority", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const path = "/api/v2/applications/{applicationId}/credentials";
		const previous = structuredClone(current);
		delete previous.paths[path];
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-issuer-v2-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			for (const mutate of [
				(document: typeof current) => {
					document.paths[path].post.security = [];
				},
				(document: typeof current) => {
					document.paths[path].get = document.paths[path].post;
				},
				(document: typeof current) => {
					delete document.paths[path].post.responses["403"];
				},
				(document: typeof current) => {
					document.paths["/api/v2/admin/audit"].get.security = [];
				},
				(document: typeof current) => {
					document.paths["/api/v2/unreviewed"] = {};
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(currentPath, JSON.stringify(changed));
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("admits only the optional write-only application default Key and rejects adjacent drift", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const previous = structuredClone(current);
		delete previous.components.schemas.AgentApplicationCreateRequestV2
			.properties.defaultRelayKey;
		const directory = await mkdtemp(
			resolve(tmpdir(), "default-key-create-compatibility-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			for (const mutation of [
				(value: typeof current) => {
					value.components.schemas.AgentApplicationCreateRequestV2.properties.defaultRelayKey.writeOnly = false;
				},
				(value: typeof current) => {
					value.components.schemas.AgentApplicationCreateRequestV2.properties.defaultRelayKey.minLength = 0;
				},
				(value: typeof current) => {
					value.components.schemas.AgentApplicationCreateRequestV2.required.push(
						"defaultRelayKey",
					);
				},
				(value: typeof current) => {
					value.components.schemas.AgentApplicationCreateRequestV2.additionalProperties = true;
				},
				(value: typeof current) => {
					value.paths["/api/v2/agents"].get.security = [];
				},
			]) {
				const changed = structuredClone(current);
				mutation(changed);
				await writeFile(currentPath, JSON.stringify(changed));
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("admits only the V2 lifecycle addition and preserves existing audit authority", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		restorePreAgentApiManagementContract(current);
		restorePreManagementRevisionContract(current);
		// Isolate lifecycle from later personal API/Relay Key and registration additions.
		restorePreRelayKeyContract(current);
		delete current.paths["/api/v2/agents/{agentId}/default-relay-key"];
		delete current.paths[
			"/api/v2/agents/{agentId}/default-relay-key/candidates"
		];
		delete current.paths["/api/v2/agents/{agentId}/configuration/saved-model"];
		delete current.components.schemas.AgentDefaultRelayKeySavedCandidatesV1;
		delete current.paths["/api/v2/applications"];
		delete current.paths["/api/v2/applications/{applicationId}"];
		delete current.paths["/api/v2/agents/{agentId}/default-relay-key"];
		delete current.paths[
			"/api/v2/agents/{agentId}/default-relay-key/candidates"
		];
		delete current.paths["/api/v2/agents/{agentId}/api-use-grants/{userId}"];
		delete current.components.schemas.AgentUserUseRevokeRequestV1;
		delete current.components.schemas.AgentUserUseRevokeResponseV1;
		// #2759 新增的用户 API 管理授权同样属于后加内容。
		delete current.paths["/api/v2/agents/{agentId}/api-manage-grants/{userId}"];
		for (const name of [
			"AgentUserManageGrantRequestV1",
			"AgentUserManageGrantResponseV1",
			"AgentUserManageRevokeRequestV1",
			"AgentUserManageRevokeResponseV1",
		])
			delete current.components.schemas[name];
		delete current.components.schemas.AgentApplicationCreateRequestV2.properties
			.defaultRelayKey;
		// #2421 之后新增的默认 Key 替换字段同样属于后加内容。
		for (const name of [
			"AgentApplicationUpdateRequestV2",
			"AgentConfigurationUpdateRequestV2",
		]) {
			if (!current.components.schemas[name]?.properties) continue;
			for (const property of [
				"defaultRelayKey",
				"expectedConfigurationRevision",
				"expectedKeyVersion",
			])
				delete current.components.schemas[name].properties[property];
		}
		delete current.components.schemas.DeploymentTemplateProjectionV2.properties
			.readiness;
		for (const name of [
			"AgentApplicationCreateRequestV2",
			"AgentApplicationUpdateRequestV2",
		])
			delete current.components.schemas[name].properties.source.anyOf[0]
				.properties.templateRevision;
		for (const name of [
			"ApplicationMetadataV1",
			"ApplicationRegistrationRequestV1",
			"ApplicationRegistrationResponseV1",
		])
			delete current.components.schemas[name];
		delete current.paths["/api/v2/agents"].get.security;
		delete current.paths["/api/v2/agents"].get.description;
		for (const name of ["AgentProjectionV1", "AgentProjectionV2"]) {
			const schema = current.components.schemas[name];
			if (schema?.properties?.capabilities?.properties)
				delete schema.properties.capabilities.properties.skills;
		}
		const previous = structuredClone(current);
		delete previous.components.schemas.AgentApiLifecycleAcceptedResponseV1;
		previous.paths["/api/v2/agents/{agentId}/lifecycle"].post.responses[
			"202"
		].content["application/json"].schema =
			previous.paths["/api/v2/agents/{agentId}/lifecycle"].post.responses[
				"202"
			].content["application/json"].schema.anyOf[0];
		for (const path of Object.keys(previous.paths)) {
			if (
				path !== "/api/v2/admin/audit" &&
				path !== "/api/v2/agents/{agentId}/file-limits" &&
				path !== "/api/v2/agents/{agentId}/channels/{channelId}/file-limits" &&
				path !== "/api/v2/admin/deployment/file-limits" &&
				path !== "/api/v2/me/conversations/recent" &&
				path !== "/api/v2/me/api-credentials" &&
				path !== "/api/v2/me/api-credentials/{credentialId}" &&
				path !== "/api/v2/skills" &&
				path !== "/api/v2/skills/imports" &&
				path !== "/api/v2/skills/installations" &&
				path !== "/api/v2/skills/installations/{installationId}" &&
				path !== "/api/v2/agents/{agentId}/versions/{agentVersion}/skills" &&
				path !== "/api/v2/agents/{agentId}/skills/current-version" &&
				path !== "/api/v2/agents/{agentId}/detail" &&
				path !== "/api/v2/admin/agents/{agentId}" &&
				path !== "/api/v2/directory/search" &&
				path !== "/api/v2/agents/{agentId}/creation-failure" &&
				path !== "/api/v2/skills/projects" &&
				path !== "/api/v2/skills/projects/{projectId}" &&
				path !== "/api/v2/skills/projects/{projectId}/content" &&
				path !== "/api/v2/skills/projects/{projectId}/versions" &&
				path !== "/api/v2/skills/reviews" &&
				path !== "/api/v2/skills/reviews/{skillVersionId}/content" &&
				path !== "/api/v2/skills/owned-versions" &&
				path !== "/api/v2/skills/versions" &&
				path !== "/api/v2/skills/versions/{skillVersionId}" &&
				path !== "/api/v2/skills/versions/{skillVersionId}/detail" &&
				path !== "/api/v2/skills/versions/{skillVersionId}/review" &&
				path !== "/api/v2/skills/versions/{skillVersionId}/revoke" &&
				path !== "/api/v2/applications/{applicationId}/credentials" &&
				path !== "/api/v2/applications/{applicationId}/material-grant" &&
				path !==
					"/api/v2/applications/{applicationId}/material-grant/{principalType}/{principalId}" &&
				!path.startsWith("/api/v2/conversations/")
			)
				delete previous.paths[path];
		}
		for (const name of [
			"AgentApplicationCreateRequestV2",
			"AgentApplicationProjectionV2",
			"AgentApplicationUpdateRequestV2",
			"AgentConfigurationProjectionV2",
			"AgentConfigurationUpdateRequestV2",
			"AgentLifecycleCommandRequestV1",
			"AgentProjectionV2",
			"ApprovalDecisionRequestV1",
			"DeploymentConfigurationProjectionV2",
			"DeploymentConfigurationStatusV2",
			"DeploymentModelCatalogProjectionV2",
			"DeploymentModelEndpointProjectionV2",
			"DeploymentModelProjectionV2",
			"DeploymentTemplateProjectionV2",
		])
			delete previous.components.schemas[name];
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-lifecycle-v2-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous), "utf8");
			await writeFile(currentPath, JSON.stringify(current), "utf8");
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			for (const mutate of [
				(document: typeof current) => {
					delete document.paths["/api/v2/agents"];
				},
				(document: typeof current) => {
					document.paths["/api/v2/unreviewed"] = {};
				},
				(document: typeof current) => {
					document.paths["/api/v2/admin/audit"].get.operationId = "changed";
				},
				(document: typeof current) => {
					document.components.schemas.AgentApplicationCreateRequestV2.required =
						[];
				},
				(document: typeof current) => {
					document.components.schemas.PlatformAuditProjectionV2.required = [];
				},
				(document: typeof current) => {
					document.info.title = "changed";
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(currentPath, JSON.stringify(changed), "utf8");
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("admits only the existing resource-unavailable response added to V2 SSE", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const path = "/api/v2/conversations/{conversationId}/events";
		const previous = structuredClone(current);
		delete previous.paths[path].get.responses["404"];
		const directory = await mkdtemp(resolve(tmpdir(), "agent-infra-sse404-"));
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			for (const mutate of [
				(document: typeof current) => {
					document.paths[path].get.responses["404"].description = "changed";
				},
				(document: typeof current) => {
					document.paths[path].get.responses["200"].description = "changed";
				},
				(document: typeof current) => {
					document.paths["/api/v2/agents"].get.operationId = "changed";
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(currentPath, JSON.stringify(changed));
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("admits reviewed V2 operation reads while preserving lifecycle and audit", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const previous = structuredClone(current);
		const reviewedCurrent = structuredClone(current);
		delete reviewedCurrent.paths[
			"/api/v2/conversations/{conversationId}/native-capability/invoke"
		];
		for (const name of [
			"NativeCapabilityInvocationRequestV1",
			"NativeCapabilityInvocationResponseV1",
			"NativeCapabilityInvocationResultV1",
		])
			delete reviewedCurrent.components.schemas[name];
		const nativeMetadataPath =
			"/api/v2/conversations/{conversationId}/executions/{executionId}/native-metadata";
		for (const path of Object.keys(previous.paths)) {
			if (
				path.startsWith("/api/v2/conversations/") &&
				path !== nativeMetadataPath
			)
				delete previous.paths[path];
		}
		for (const name of [
			"AuthorizationRevokedSignalV1",
			"ConversationDetailProjectionV2",
			"ConversationSseMessageV1",
			"ConversationSseMessageV2",
			"ExecutionDetailProjectionV2",
			"ExecutionOperationEventV2",
			"HeartbeatSignalV1",
			"ModelSelectionFallbackEventV1",
			"PersistedConversationEventV1",
			"PersistedConversationEventV2",
			"RuntimeConnectionAssociationV1",
			"RuntimeOperationFactV2",
			"RuntimeOperationFailureV2",
			"SseEventIdV1",
			"TimelineReloadSignalV1",
			"NativeCapabilityInvocationRequestV1",
			"NativeCapabilityInvocationResponseV1",
			"NativeCapabilityInvocationResultV1",
			// 该基线早于 #2979 的思考过程事件。
			"ReasoningDeltaEventV2",
			// 该基线早于 #3226 的结果文件事件 V2。
			"ResultFileEventV2",
		])
			delete previous.components.schemas[name];
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-operation-v2-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(reviewedCurrent));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			for (const mutate of [
				(document: typeof current) => {
					delete document.paths["/api/v2/conversations/{conversationId}/events"]
						.get.responses["404"];
				},
				(document: typeof current) => {
					document.paths[
						"/api/v2/conversations/{conversationId}/events"
					].get.responses["404"].description = "changed";
				},
				(document: typeof current) => {
					delete document.paths[
						"/api/v2/conversations/{conversationId}/events"
					];
				},
				(document: typeof current) => {
					document.components.schemas.RuntimeOperationFactV2.required = [];
				},
				(document: typeof current) => {
					document.paths["/api/v2/agents"].get.operationId = "changed";
				},
				(document: typeof current) => {
					document.components.schemas.PlatformAuditProjectionV2.required = [];
				},
				(document: typeof current) => {
					document.paths["/api/v2/conversations/unreviewed"] = {};
				},
				// Only the exact #1534 Session availability may bypass the pinned digest.
				(document: typeof current) => {
					document.components.schemas.ConversationDetailProjectionV2.properties.sessionAvailability =
						{ type: "string" };
				},
				(document: typeof current) => {
					document.components.schemas.ConversationDetailProjectionV2.properties.sessionAvailability.enum.push(
						"starting",
					);
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(currentPath, JSON.stringify(changed));
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("does not bypass native metadata review when native admission is added together", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const previous = structuredClone(current);
		delete previous.paths[
			"/api/v2/conversations/{conversationId}/executions/{executionId}/native-metadata"
		];
		delete previous.paths[
			"/api/v2/conversations/{conversationId}/native-capability/invoke"
		];
		for (const name of [
			"NativeMetadataProjectionV1",
			"NativeCapabilityInvocationRequestV1",
			"NativeCapabilityInvocationResponseV1",
			"NativeCapabilityInvocationResultV1",
		])
			delete previous.components.schemas[name];
		const directory = await mkdtemp(
			resolve(tmpdir(), "native-capability-compat-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			const changed = structuredClone(current);
			changed.components.schemas.NativeMetadataProjectionV1.oneOf[0].properties.status.enum =
				["changed"];
			await writeFile(currentPath, JSON.stringify(changed));
			expect(comparePaths(currentPath, previousPath).status).toBe(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("admits only the exact FileLimits declaration management addition (#3061)", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const agentPath = "/api/v2/agents/{agentId}/file-limits";
		const channelPath =
			"/api/v2/agents/{agentId}/channels/{channelId}/file-limits";
		const deploymentPath = "/api/v2/admin/deployment/file-limits";
		const paths = [agentPath, channelPath, deploymentPath];
		const schemas = [
			"FileLimitDeclarationProjectionV1",
			"FileLimitDeclarationResponseV1",
			"FileLimitDeclarationWriteRequestV1",
		];
		const previous = structuredClone(current);
		for (const path of paths) delete previous.paths[path];
		for (const name of schemas) delete previous.components.schemas[name];
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-file-limits-compat-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			for (const mutate of [
				(document: typeof current) => {
					document.paths[agentPath].put.operationId = "unreviewed";
				},
				(document: typeof current) => {
					document.components.schemas.FileLimitDeclarationWriteRequestV1.properties.declaration.properties.maxBytes.maximum = 1024;
				},
				(document: typeof current) => {
					document.components.schemas.FileLimitDeclarationWriteRequestV1.properties.schemaVersion.const = 2;
				},
				(document: typeof current) => {
					document.paths["/api/v2/admin/unreviewed"] =
						document.paths[deploymentPath];
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(currentPath, JSON.stringify(changed));
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("admits only the exact FileLimits declaration schemas in the file API (#3061)", async () => {
		const current = JSON.parse(await readFile(filesArtifactPath, "utf8"));
		const schemas = [
			"FileLimitDeclarationInputV1",
			"FileLimitDeclarationProjectionV1",
			"FileLimitDeclarationResponseV1",
			"FileLimitDeclarationScopeV1",
			"FileLimitDeclarationWriteRequestV1",
		];
		const previous = structuredClone(current);
		for (const name of schemas) delete previous.components.schemas[name];
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-file-limits-files-compat-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			const changed = structuredClone(current);
			changed.components.schemas.FileLimitDeclarationInputV1.properties.mediaTypes.maxItems = 64;
			await writeFile(currentPath, JSON.stringify(changed));
			expect(comparePaths(currentPath, previousPath).status).toBe(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each([
		["removed", "removed"],
		["narrowed", "narrowed"],
		["retyped", "retyped"],
	])("rejects %s schema changes", (fixture, reason) => {
		const result = compare(fixture);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(reason);
	});

	it("admits only the optional Session availability on the V2 Conversation detail (#1534)", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const previous = structuredClone(current);
		delete previous.components.schemas.ConversationDetailProjectionV2.properties
			.sessionAvailability;
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-session-availability-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			for (const mutate of [
				(document: typeof current) => {
					document.components.schemas.ConversationDetailProjectionV2.required.push(
						"sessionAvailability",
					);
				},
				(document: typeof current) => {
					document.components.schemas.ConversationDetailProjectionV2.properties.sessionAvailability.enum.push(
						"starting",
					);
				},
				(document: typeof current) => {
					document.components.schemas.ConversationDetailProjectionV2.properties.schemaVersion =
						{ const: 3, type: "number" };
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(currentPath, JSON.stringify(changed));
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("admits only the added updating Session availability (#1523)", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		expect(
			current.components.schemas.ConversationDetailProjectionV2.properties
				.sessionAvailability.enum,
		).toEqual(["preparing", "ready", "unavailable", "updating"]);
		const previous = structuredClone(current);
		previous.components.schemas.ConversationDetailProjectionV2.properties.sessionAvailability.enum =
			["preparing", "ready", "unavailable"];
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-session-updating-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			for (const mutate of [
				(document: typeof current) => {
					document.components.schemas.ConversationDetailProjectionV2.required.push(
						"sessionAvailability",
					);
				},
				(document: typeof current) => {
					document.components.schemas.ConversationDetailProjectionV2.properties.sessionAvailability.enum.push(
						"starting",
					);
				},
				(document: typeof current) => {
					document.components.schemas.ConversationDetailProjectionV2.properties.sessionAvailability.enum =
						["ready", "unavailable", "updating"];
				},
				(document: typeof current) => {
					document.components.schemas.ConversationDetailProjectionV2.properties.schemaVersion =
						{ const: 3, type: "number" };
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(currentPath, JSON.stringify(changed));
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("accepts only the exact file addition and rejects altered authorization, limits and old operations", async () => {
		const current = JSON.parse(
			await readFile(pilotBrowserArtifactPath, "utf8"),
		);
		const previous = structuredClone(current);
		for (const path of Object.keys(previous.paths))
			if (path.includes("/files")) delete previous.paths[path];
		// FileLimit declarations are a separate additive contract (#3061).
		const fileLimitDeclarationSchemas = new Set([
			"FileLimitDeclarationInputV1",
			"FileLimitDeclarationProjectionV1",
			"FileLimitDeclarationResponseV1",
			"FileLimitDeclarationScopeV1",
			"FileLimitDeclarationWriteRequestV1",
		]);
		for (const name of Object.keys(previous.components.schemas))
			if (name.startsWith("File") && !fileLimitDeclarationSchemas.has(name))
				delete previous.components.schemas[name];
		delete previous.components.schemas.MessageCommandRequestV1.properties
			.attachments;
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-files-compatibility-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			const changedPath = structuredClone(current);
			delete changedPath.paths[
				"/api/v1/conversations/{conversationId}/files/{fileId}/content"
			].get.parameters;
			const changedScope = structuredClone(current);
			delete changedScope.components.schemas.FileAccessClaimsV1.properties
				.actorId;
			const changedLimit = structuredClone(current);
			changedLimit.components.schemas.MessageCommandRequestV1.properties.attachments.maxItems = 64;
			const required = structuredClone(current);
			required.components.schemas.MessageCommandRequestV1.required.push(
				"attachments",
			);
			const oldOperation = structuredClone(current);
			delete oldOperation.paths[
				"/api/v1/conversations/{conversationId}/messages"
			].post;
			for (const changed of [
				changedPath,
				changedScope,
				changedLimit,
				required,
				oldOperation,
			]) {
				await writeFile(currentPath, JSON.stringify(changed));
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each([
		["removed", "removed"],
		["narrowed", "narrowed"],
		["retyped", "retyped"],
	])("rejects %s schema changes", (fixture, reason) => {
		const result = compare(fixture);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(reason);
	});

	it("rejects adding an overlapping oneOf option", () => {
		const result = compare("advanced-narrowed", "advanced-base");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("narrowed $defs.ExclusiveChoiceV1 oneOf");
		expect(result.stderr).toContain(
			"narrowed $defs.DiscriminatedChoiceV1 oneOf",
		);
		expect(result.stderr).toContain(
			"narrowed $defs.UntypedDiscriminatedChoiceV1 oneOf",
		);
	});

	it("rejects shortening a closed tuple prefix", () => {
		const result = compare("advanced-narrowed", "advanced-base");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("narrowed $defs.TupleV1[0] prefixItems");
	});

	it("rejects replacing a true schema with false", () => {
		const result = compare("advanced-narrowed", "advanced-base");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("narrowed $defs.BooleanSchemaV1 schema");
	});

	it("rejects constraining a property previously governed by an open object", () => {
		const result = compare("advanced-narrowed", "advanced-base");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("narrowed $defs.OpenObjectV1.foo property");
	});

	it.each(["--previous", "--current"])(
		"rejects an unpaired %s fixture argument",
		(option) => {
			const result = spawnSync(
				process.execPath,
				[cliPath, option, fixturePath("base")],
				{ encoding: "utf8" },
			);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("Usage: compatibility.mjs");
		},
	);

	it("rejects adding a dependent required property", () => {
		const result = compare("advanced-narrowed", "advanced-base");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"narrowed $defs.DependentObjectV1.creditCard dependentRequired billingAddress",
		);
	});

	it("rejects nested definition and pattern-property narrowings", () => {
		const result = compare("advanced-narrowed", "advanced-base");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("retyped $defs.NestedDefsV1.$defs.Value");
		expect(result.stderr).toContain(
			"narrowed $defs.PatternObjectV1.^x patternProperties",
		);
		expect(result.stderr).toContain(
			"retyped $defs.PatternExplicitV1.x patternProperties ^x",
		);
		expect(result.stderr).toContain(
			"removed $defs.RemovedNestedDefV1.$defs.Value",
		);
		expect(result.stderr).toContain(
			"removed $defs.UnusedNestedDefV1.$defs.Value",
		);
		expect(result.stderr).toContain(
			"retyped $defs.PatternToPropertyV1.x property ^x",
		);
	});

	it("fails closed for unsupported evaluation constraints", () => {
		const result = compare("advanced-narrowed", "advanced-base");
		expect(result.status).toBe(1);
		for (const keyword of [
			"dependentSchemas",
			"if",
			"then",
			"else",
			"unevaluatedProperties",
			"unevaluatedItems",
		]) {
			expect(result.stderr).toContain(keyword);
		}
	});

	it("accepts removed constraints and proven one-to-many schema widening", () => {
		const result = compare("advanced-widened", "advanced-base");
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});
});

it("admits only the exact approved opaque Skill package VersionId correction", async () => {
	const directory = await mkdtemp(
		resolve(tmpdir(), "skill-version-compatibility-"),
	);
	try {
		const document = JSON.parse(
			await readFile(
				resolve(
					repositoryRoot,
					"packages/contracts/artifacts/json-schema/worker-result.v1.schema.json",
				),
				"utf8",
			),
		);
		const baseline = structuredClone(document);
		const objects: Record<string, unknown>[] = [];
		const visit = (value: unknown) => {
			if (!value || typeof value !== "object") return;
			const object = value as Record<string, unknown>;
			const properties = object.properties as
				| Record<string, unknown>
				| undefined;
			if (properties?.packageObjectVersion) {
				objects.push(properties);
				properties.packageObjectVersion = {
					pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
					type: "string",
				};
			}
			for (const child of Object.values(object)) visit(child);
		};
		visit(baseline);
		expect(objects.length).toBeGreaterThan(0);
		const oldPath = resolve(directory, "old.json");
		const newPath = resolve(directory, "new.json");
		await writeFile(oldPath, JSON.stringify(baseline));
		await writeFile(newPath, JSON.stringify(document));
		expect(comparePaths(newPath, oldPath).status).toBe(0);
		const mutations = [
			(properties: Record<string, unknown>) => {
				properties.packageObjectVersion = { type: "string" };
			},
			(properties: Record<string, unknown>) => {
				properties.signatureDigest = { type: "number" };
			},
			(properties: Record<string, unknown>) => {
				properties.packageObjectVersion = {
					...(properties.packageObjectVersion as object),
					maxLength: 4096,
				};
			},
		];
		for (const mutate of mutations) {
			const changed = structuredClone(document);
			const change = (value: unknown) => {
				if (!value || typeof value !== "object") return;
				const object = value as Record<string, unknown>;
				const properties = object.properties as
					| Record<string, unknown>
					| undefined;
				if (properties?.packageObjectVersion) mutate(properties);
				for (const child of Object.values(object)) change(child);
			};
			change(changed);
			await writeFile(newPath, JSON.stringify(changed));
			expect(comparePaths(newPath, oldPath).status).toBe(1);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("admits only the appended multi-service resource cap error code (#2396)", async () => {
	const code = "MULTI_SERVICE_RESOURCE_CAP_EXCEEDED";
	const current = JSON.parse(
		await readFile(
			new URL(
				"../artifacts/openapi/pilot-browser.v2.openapi.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	const enums: string[][] = [];
	const collect = (value: unknown) => {
		if (!value || typeof value !== "object") return;
		const object = value as Record<string, unknown>;
		if (Array.isArray(object.enum) && object.enum.includes(code))
			enums.push(object.enum as string[]);
		for (const child of Object.values(object)) collect(child);
	};
	collect(current);
	expect(enums.length).toBeGreaterThan(0);
	const previous = structuredClone(current);
	const restore = (value: unknown) => {
		if (!value || typeof value !== "object") return;
		const object = value as Record<string, unknown>;
		if (Array.isArray(object.enum))
			object.enum = object.enum.filter((entry) => entry !== code);
		for (const child of Object.values(object)) restore(child);
	};
	restore(previous);
	const directory = await mkdtemp(resolve(tmpdir(), "cap-error-compat-"));
	const before = resolve(directory, "previous.json");
	const after = resolve(directory, "current.json");
	try {
		await writeFile(before, JSON.stringify(previous));
		await writeFile(after, JSON.stringify(current));
		expect(comparePaths(after, before).status).toBe(0);
		// 同时删除既有错误码仍是破坏性变更。
		const narrowed = structuredClone(current);
		const removeExisting = (value: unknown) => {
			if (!value || typeof value !== "object") return;
			const object = value as Record<string, unknown>;
			if (Array.isArray(object.enum) && object.enum.includes(code))
				object.enum = object.enum.filter(
					(entry) => entry !== "MODEL_SELECTION_INVALID",
				);
			for (const child of Object.values(object)) removeExisting(child);
		};
		removeExisting(narrowed);
		await writeFile(after, JSON.stringify(narrowed));
		expect(comparePaths(after, before).status).toBe(1);
		// 基线已有该错误码时，删除它会被检测到。
		await writeFile(before, JSON.stringify(current));
		await writeFile(after, JSON.stringify(previous));
		expect(comparePaths(after, before).status).toBe(1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
