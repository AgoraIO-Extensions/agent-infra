// @vitest-environment jsdom

import type { ProviderUpgradeTask } from "@agent-infra/connection-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	confirmAuthorization: vi.fn(async () => ({ grantId: "grant-created" })),
	connectProviderCredential: vi.fn(async () => ({
		connectionId: "connection-bitbucket",
	})),
	upgradeProviderConnection: vi.fn(async (connectionId: string) => ({
		connectionId,
	})),
	createAuthorizationPreview: vi.fn(
		async (input?: { actionVersionIds?: string[] }) => ({
			idempotencyKey: "confirmation-idempotency-key",
			preview: {
				actions: [
					{
						description: "读取 Pull Request",
						effect: "READ" as const,
						id: "github.get_pull_request@v2",
						name: "github.get_pull_request",
						requiredScopes: ["repo"],
					},
					{
						description: "创建 Pull Request",
						effect: "WRITE" as const,
						id: "github.create_pull_request@v2",
						name: "github.create_pull_request",
						requiredScopes: ["repo"],
					},
				].filter(
					(action) =>
						!input?.actionVersionIds ||
						input.actionVersionIds.includes(action.id),
				),
				confirmationToken: "confirmation-token",
				consumer: { id: "consumer-codex", name: "Codex" },
				effectSummary: ["WRITE" as const],
				expiresAt: "2026-08-26T12:00:00.000Z",
				previewId: "preview-id",
				requiredScopes: ["repo"],
				targetConnection: {
					displayName: "GitHub",
					externalAccount: "guoxianzhe",
					id: "connection-personal",
				},
			},
		}),
	),
	createSharedScope: vi.fn(async () => ({ sharedScopeId: "scope-created" })),
	disconnectConnection: vi.fn(async () => undefined),
	disconnectSharedConnection: vi.fn(async () => undefined),
	getConnections: vi.fn(async () => ({
		account: { displayName: "郭贤哲", email: "guoxianzhe@agora.io" },
		isAdministrator: true,
		overview: {
			actions: [],
			connections: [
				{
					actionVersionIds: ["confluence.get_page_by_id@v1"],
					displayName: "Confluence",
					externalAccount: "guoxianzhe",
					id: "connection-confluence",
					ownerType: "PERSONAL" as const,
					providerId: "confluence",
					requiresReconnect: false,
					status: "ACTIVE",
				},
				{
					actionVersionIds: [],
					displayName: "connectionE2E2",
					externalAccount: "329435106",
					id: "connection-personal",
					ownerType: "PERSONAL" as const,
					providerId: "github",
					requiresReconnect: false,
					status: "ACTIVE",
				},
				{
					actionVersionIds: [],
					displayName: "旧 GitHub",
					externalAccount: "guoxianzhe-old",
					id: "connection-old",
					ownerType: "PERSONAL" as const,
					providerId: "github",
					requiresReconnect: true,
					status: "DISCONNECTED",
				},
				{
					actionVersionIds: ["jenkins-release.get_build@v2"],
					displayName: "Jenkins Release",
					externalAccount: "guoxianzhe",
					id: "connection-jenkins",
					ownerType: "PERSONAL" as const,
					providerId: "jenkins-release",
					requiresReconnect: true,
					status: "ACTIVE",
				},
				{
					actionVersionIds: ["datalego.get_current_user@v1"],
					displayName: "Disconnected DataLego",
					externalAccount: "old@example.invalid",
					id: "connection-datalego-old",
					ownerType: "PERSONAL" as const,
					providerId: "datalego",
					requiresReconnect: false,
					status: "DISCONNECTED",
				},
			],
			consumers: [{ id: "consumer-codex", name: "Codex" }],
			grants: [
				{
					actionVersionIds: ["github.get_repository@v2"],
					actions: [
						{
							effect: "READ" as "READ" | "WRITE",
							id: "github.get_repository@v2",
							name: "github.get_repository",
						},
					],
					consumerId: "consumer-codex",
					consumerName: "Codex",
					connectionDisplayName: "GitHub",
					connectionId: "connection-personal",
					externalAccount: "guoxianzhe",
					id: "grant-codex",
					providerId: "github",
					status: "ACTIVE",
				},
			],
			upgradeTasks: [] as ProviderUpgradeTask[],
		},
	})),
	getSharedConnections: vi.fn(async () => ({
		overview: {
			principals: [
				{
					displayName: "可用员工",
					email: "member@agora.io",
					principalId: "principal-member",
				},
				{
					displayName: "待授权员工",
					email: "candidate@agora.io",
					principalId: "principal-candidate",
				},
			],
			scopes: [
				{
					connections: [
						{
							displayName: "Shared GitHub",
							externalAccount: "agora-release-bot",
							id: "connection-shared",
							status: "ACTIVE",
						},
					],
					displayName: "声网研发",
					members: ["principal-member"],
					sharedScopeId: "scope-company",
					state: "ACTIVE" as const,
				},
			],
		},
	})),
	grantAdministrator: vi.fn(async () => undefined),
	grantSharedScopePrincipal: vi.fn(async () => undefined),
	issueToken: vi.fn(async () => ({
		issued: {
			expiresAt: "2026-11-26T00:00:00.000Z",
			name: "Codex 本机",
			token: "conn_pat_one_time",
		},
	})),
	listAdministrators: vi.fn(async () => ({
		administrators: [
			{
				displayName: "管理员",
				email: "admin@agora.io",
				isAdministrator: true,
				principalId: "principal-admin",
			},
			{
				displayName: "普通用户",
				email: "user@agora.io",
				isAdministrator: false,
				principalId: "principal-user",
			},
		],
	})),
	listProviderUpgradeCampaigns: vi.fn(async () => ({
		campaigns: [
			{
				completedCount: 3,
				createdAt: "2026-09-21T00:00:00.000Z",
				deadlineAt: null,
				expiredCount: 0,
				id: "campaign-bitbucket-v7",
				pendingCount: 2,
				providerId: "bitbucket",
				reason: "Provider authorization contract changed",
				sourceProviderReleaseId: "connection-v6",
				targetProviderReleaseId: "connection-v7",
				totalCount: 5,
			},
		],
	})),
	listTokens: vi.fn(async () => ({
		consumers: [
			{ id: "consumer-portable-pat", name: "Portable Connection PAT" },
			{ id: "consumer-rehoboam-ai", name: "RehoboamAI" },
		],
		tokens: [
			{
				consumerId: "consumer-rehoboam-ai",
				consumerName: "RehoboamAI",
				createdAt: "2026-08-26T00:00:00.000Z",
				expiresAt: "2026-11-26T00:00:00.000Z",
				lastUsedAt: null,
				name: "现有 Token",
				status: "ACTIVE",
				tokenId: "token-existing",
			},
		],
	})),
	renameSharedScope: vi.fn(async () => undefined),
	revokeAdministrator: vi.fn(async () => undefined),
	revokeGrant: vi.fn(async () => undefined),
	revokeSharedScopePrincipal: vi.fn(async () => undefined),
	revokeToken: vi.fn(async () => undefined),
	startGithubOAuth: vi.fn(async () => ({
		authorizationUrl: "https://github.example/authorize",
	})),
}));

vi.mock("../api", () => ({ connectionApi: api }));
vi.mock("../shell", () => ({
	ConsoleShell: ({ children }: { children: ReactNode }) => <>{children}</>,
	PageError: () => <div role="alert">请求失败</div>,
}));

import { AdministratorsPage } from "./administrators-page";
import { ConnectionsPage } from "./connections-page";
import { SharedConnectionsPage } from "./shared-connections-page";
import { TokensPage } from "./tokens-page";

afterEach(() => {
	cleanup();
	window.history.replaceState({}, "", "/");
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

function renderPage(page: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{page}</QueryClientProvider>,
	);
}

function calls(mock: unknown) {
	return (mock as { mock: { calls: unknown[][] } }).mock.calls;
}

describe("Connection 管理 mutation wiring", () => {
	it("升级连接时显示进行中和成功反馈", async () => {
		let finishUpgrade: ((value: { connectionId: string }) => void) | undefined;
		api.upgradeProviderConnection.mockImplementationOnce(
			(connectionId: string) =>
				new Promise((resolve) => {
					finishUpgrade = resolve;
				}).then(() => ({ connectionId })),
		);
		renderPage(<ConnectionsPage />);
		fireEvent.click(
			await screen.findByRole("button", { name: /Jenkins Release 已连接/ }),
		);
		await screen.findByRole("heading", { level: 2, name: "Jenkins Release" });

		fireEvent.click(screen.getByRole("button", { name: "升级连接" }));
		const pending = await screen.findByRole("button", { name: "正在升级" });
		expect((pending as HTMLButtonElement).disabled).toBe(true);
		finishUpgrade?.({ connectionId: "connection-jenkins" });

		expect(
			(await screen.findByText("连接已升级，可以重新确认客户端授权。"))
				.textContent,
		).toBe("连接已升级，可以重新确认客户端授权。");
	});

	it("批量升级按 Connection 去重并隔离失败", async () => {
		const initial = await api.getConnections();
		initial.overview.upgradeTasks = [
			{
				campaignId: "campaign-1",
				connectionId: "connection-alpha",
				consumerId: "consumer-codex",
				consumerName: "Codex",
				deadlineAt: null,
				providerId: "jenkins-ci",
				reason: "Provider upgraded",
				status: "PENDING_CONNECTION",
				targetProviderReleaseId: "jenkins-ci-connection-v8",
				taskId: "task-alpha-codex",
			},
			{
				campaignId: "campaign-1",
				connectionId: "connection-alpha",
				consumerId: "consumer-rehoboam",
				consumerName: "RehoboamAI",
				deadlineAt: null,
				providerId: "jenkins-ci",
				reason: "Provider upgraded",
				status: "PENDING_CONNECTION",
				targetProviderReleaseId: "jenkins-ci-connection-v8",
				taskId: "task-alpha-rehoboam",
			},
			{
				campaignId: "campaign-2",
				connectionId: "connection-beta",
				consumerId: "consumer-codex",
				consumerName: "Codex",
				deadlineAt: null,
				providerId: "rehoboam",
				reason: "Provider upgraded",
				status: "PENDING_CONNECTION",
				targetProviderReleaseId: "rehoboam-connection-v4",
				taskId: "task-beta-codex",
			},
		];
		const refreshed = structuredClone(initial);
		refreshed.overview.upgradeTasks = [
			{
				...initial.overview.upgradeTasks[0],
				status: "PENDING_AUTHORIZATION",
			},
			initial.overview.upgradeTasks[2],
		];
		api.getConnections
			.mockResolvedValueOnce(initial)
			.mockResolvedValueOnce(refreshed);
		api.upgradeProviderConnection
			.mockResolvedValueOnce({ connectionId: "connection-alpha" })
			.mockRejectedValueOnce(new Error("upgrade failed"));

		renderPage(<ConnectionsPage />);
		fireEvent.click(
			await screen.findByRole("button", {
				name: "一键升级 2 个连接",
			}),
		);

		await waitFor(() =>
			expect(api.upgradeProviderConnection).toHaveBeenCalledTimes(2),
		);
		expect(calls(api.upgradeProviderConnection).map((call) => call[0])).toEqual(
			["connection-alpha", "connection-beta"],
		);
		expect(
			await screen.findByText(
				"批量处理完成：1 个连接已升级，1 个失败，1 条授权待确认。",
			),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "重试 1 个失败项" }),
		).toBeTruthy();
	});

	it("升级任务复用服务端保存的凭证", async () => {
		const initial = await api.getConnections();
		initial.overview.upgradeTasks = [
			{
				campaignId: "campaign-rehoboam",
				connectionId: "connection-rehoboam",
				consumerId: "consumer-codex",
				consumerName: "Codex",
				deadlineAt: null,
				providerId: "rehoboam",
				reason: "Provider upgraded",
				status: "PENDING_CONNECTION",
				targetProviderReleaseId: "rehoboam-connection-v4",
				taskId: "task-rehoboam",
			},
		];
		api.getConnections.mockResolvedValueOnce(initial);

		renderPage(<ConnectionsPage />);
		fireEvent.click(await screen.findByRole("button", { name: "处理升级" }));

		await waitFor(() =>
			expect(calls(api.upgradeProviderConnection)[0]?.[0]).toBe(
				"connection-rehoboam",
			),
		);
		expect(screen.queryByRole("heading", { name: "连接 Rehoboam" })).toBeNull();
	});

	it("批量升级刷新失败后解除进行中状态", async () => {
		const initial = await api.getConnections();
		initial.overview.upgradeTasks = [
			{
				campaignId: "campaign-1",
				connectionId: "connection-alpha",
				consumerId: "consumer-codex",
				consumerName: "Codex",
				deadlineAt: null,
				providerId: "jenkins-ci",
				reason: "Provider upgraded",
				status: "PENDING_CONNECTION",
				targetProviderReleaseId: "jenkins-ci-connection-v8",
				taskId: "task-alpha",
			},
			{
				campaignId: "campaign-2",
				connectionId: "connection-beta",
				consumerId: "consumer-codex",
				consumerName: "Codex",
				deadlineAt: null,
				providerId: "rehoboam",
				reason: "Provider upgraded",
				status: "PENDING_CONNECTION",
				targetProviderReleaseId: "rehoboam-connection-v4",
				taskId: "task-beta",
			},
		];
		api.getConnections
			.mockResolvedValueOnce(initial)
			.mockRejectedValueOnce(new Error("refresh failed"));

		renderPage(<ConnectionsPage />);
		fireEvent.click(
			await screen.findByRole("button", {
				name: "一键升级 2 个连接",
			}),
		);

		expect(
			await screen.findByText(
				"批量升级请求已处理，但刷新结果失败；请刷新页面确认最新状态。",
			),
		).toBeTruthy();
		expect(
			(
				screen.getByRole("button", {
					name: "一键升级 2 个连接",
				}) as HTMLButtonElement
			).disabled,
		).toBe(false);
	});

	it("根据 MCP 恢复链接直接打开目标 Provider 的连接界面", async () => {
		window.history.replaceState(
			{},
			"",
			"/connection/connections?provider=confluence&intent=connect",
		);
		renderPage(<ConnectionsPage />);

		expect(
			await screen.findByRole("heading", { name: "连接公司 Confluence" }),
		).toBeTruthy();
	});

	it("根据 MCP 授权链接直接打开目标 Provider 的客户端授权界面", async () => {
		window.history.replaceState(
			{},
			"",
			"/connection/connections?provider=confluence&intent=authorize",
		);
		renderPage(<ConnectionsPage />);

		expect(
			await screen.findByRole("heading", { name: "授权客户端" }),
		).toBeTruthy();
	});

	it("健康 GitHub 连接会清理 callback_failed 提示", async () => {
		window.history.replaceState(
			{},
			"",
			"/connection/connections?oauth=callback_failed",
		);
		renderPage(<ConnectionsPage />);

		await screen.findByRole("heading", { name: "connectionE2E2" });
		await waitFor(() => expect(window.location.search).toBe(""));
		expect(
			screen.queryByText("GitHub 授权回跳未确认，请以当前连接状态为准。"),
		).toBeNull();
	});

	it("连接页调用 GitHub、Bitbucket、授权、断开和 Grant API", async () => {
		vi.spyOn(window, "confirm").mockReturnValue(true);
		const open = vi.spyOn(window, "open");
		renderPage(<ConnectionsPage />);
		await screen.findByRole("heading", { name: "客户端授权" });
		expect(
			screen.getByRole("heading", { name: "connectionE2E2" }),
		).toBeTruthy();
		expect(screen.getAllByText("329435106").length).toBeGreaterThanOrEqual(1);
		expect(screen.getAllByText("GitHub").length).toBeGreaterThanOrEqual(2);
		expect(screen.queryByText("github.get_repository")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Bitbucket 未连接" }));
		fireEvent.click(screen.getByRole("button", { name: "连接" }));
		fireEvent.change(screen.getByLabelText("Personal Access Token"), {
			target: { value: "test-bitbucket-pat" },
		});
		fireEvent.click(screen.getByRole("button", { name: "连接" }));
		await waitFor(() =>
			expect(api.connectProviderCredential).toHaveBeenCalledOnce(),
		);
		expect(calls(api.connectProviderCredential)[0]?.[0]).toEqual({
			accessToken: "test-bitbucket-pat",
			providerId: "bitbucket",
		});

		fireEvent.click(screen.getByRole("button", { name: /GitHub 已连接/ }));
		fireEvent.click(screen.getByRole("button", { name: "再连接" }));
		await waitFor(() => expect(api.startGithubOAuth).toHaveBeenCalledOnce());
		expect(calls(api.startGithubOAuth)[0]?.[0]).toBeUndefined();
		expect(open).not.toHaveBeenCalled();

		fireEvent.click(
			screen.getByRole("button", { name: /connectionE2E2 329435106/ }),
		);
		fireEvent.click(screen.getByRole("button", { name: "断开 Connection" }));
		await waitFor(() =>
			expect(api.disconnectConnection).toHaveBeenCalledOnce(),
		);
		expect(calls(api.disconnectConnection)[0]?.[0]).toBe("connection-personal");
		fireEvent.click(screen.getByRole("button", { name: "撤销 Codex" }));
		await waitFor(() => expect(api.revokeGrant).toHaveBeenCalledOnce());
		expect(calls(api.revokeGrant)[0]?.[0]).toBe("grant-codex");

		fireEvent.click(screen.getByRole("button", { name: "授权客户端" }));
		fireEvent.click(screen.getByRole("button", { name: "查看授权内容" }));
		await screen.findByRole("button", { name: "查看授权差异" });
		expect(screen.getByText("已选择 0 / 共 2 项")).toBeTruthy();
		fireEvent.click(
			screen.getByRole("checkbox", { name: /github.get_pull_request/ }),
		);
		fireEvent.click(screen.getByRole("button", { name: "查看授权差异" }));
		await screen.findByRole("button", { name: "确认授权" });
		expect(calls(api.createAuthorizationPreview).at(-1)?.[0]).toEqual({
			actionVersionIds: ["github.get_pull_request@v2"],
			connectionId: "connection-personal",
			consumerId: "consumer-codex",
		});
		fireEvent.click(screen.getByRole("button", { name: "确认授权" }));
		await waitFor(() =>
			expect(api.confirmAuthorization).toHaveBeenCalledOnce(),
		);
		expect(calls(api.confirmAuthorization)[0]?.[0]).toEqual({
			confirmationToken: "confirmation-token",
			idempotencyKey: "confirmation-idempotency-key",
			previewId: "preview-id",
		});
	});

	it("升级授权沿用旧版选择，不默认勾选新增 Action", async () => {
		const overview = await api.getConnections();
		const grant = overview.overview.grants[0];
		if (!grant) throw new Error("测试需要旧 Grant");
		grant.status = "PAUSED_CREDENTIAL";
		grant.actionVersionIds = ["github.create_pull_request@v5"];
		grant.actions = [
			{
				id: "github.create_pull_request@v5",
				name: "github.create_pull_request",
				effect: "WRITE",
			},
		];
		overview.overview.upgradeTasks = [
			{
				campaignId: "campaign-upgrade",
				connectionId: "connection-personal",
				consumerId: "consumer-codex",
				consumerName: "Codex",
				deadlineAt: null,
				providerId: "github",
				reason: "Provider upgraded",
				status: "PENDING_AUTHORIZATION",
				targetProviderReleaseId: "github-v6",
				taskId: "task-upgrade",
			},
		];
		api.getConnections.mockResolvedValueOnce(overview);
		renderPage(<ConnectionsPage />);
		fireEvent.click(await screen.findByRole("button", { name: "确认授权" }));
		fireEvent.click(screen.getByRole("button", { name: "查看授权内容" }));
		await screen.findByText("已选择 1 / 共 2 项");
		expect(
			(
				screen.getByRole("checkbox", {
					name: /github.create_pull_request/,
				}) as HTMLInputElement
			).checked,
		).toBe(true);
		expect(
			(
				screen.getByRole("checkbox", {
					name: /github.get_pull_request/,
				}) as HTMLInputElement
			).checked,
		).toBe(false);
	});

	it.each([
		{ entry: "upgrade", count: 14, status: "PAUSED_CREDENTIAL" },
		{ entry: "normal", count: 14, status: "PAUSED_CREDENTIAL" },
		{ entry: "upgrade", count: 3, status: "PAUSED_CREDENTIAL" },
		{ entry: "upgrade", count: 3, status: "ACTIVE" },
		{ entry: "upgrade", count: 0, status: "REVOKED" },
		{ entry: "upgrade", count: 0, status: "TERMINATED" },
	])(
		"$entry 入口沿用最新 $status 授权的 $count 项，不合并历史权限",
		async ({ entry, count, status }) => {
			const overview = await api.getConnections();
			const template = overview.overview.grants[0];
			if (!template) throw new Error("测试需要 Grant");
			const actions = Array.from({ length: 15 }, (_, index) => ({
				id: `rehoboam.action_${index}@v6`,
				name:
					index === 0
						? "rehoboam.get_current_user"
						: `rehoboam.action_${index}`,
				effect: index < 10 ? ("READ" as const) : ("WRITE" as const),
				description: `Action ${index}`,
				requiredScopes: [],
			}));
			const oldActions = actions.slice(0, 14).map((action) => ({
				...action,
				id: action.id.replace("@v6", "@v5"),
			}));
			const latest = {
				...template,
				id: "grant-z-latest",
				status,
				actions: oldActions.slice(0, count || 14),
				actionVersionIds: oldActions
					.slice(0, count || 14)
					.map((action) => action.id),
			};
			// The server returns newest decisions first, regardless of lexicographic IDs.
			overview.overview.grants = [
				{ ...template, connectionId: "other-connection", actions: oldActions },
				{ ...template, consumerId: "other-consumer", actions: oldActions },
				latest,
				{
					...template,
					id: "grant-a-old",
					status: "PAUSED_CREDENTIAL",
					actions: oldActions.slice(0, 1),
				},
				{
					...template,
					id: "grant-b-old-full",
					status: "PAUSED_CREDENTIAL",
					actions: oldActions,
				},
			];
			overview.overview.upgradeTasks = [
				{
					campaignId: "campaign-upgrade",
					connectionId: template.connectionId,
					consumerId: template.consumerId,
					consumerName: "Codex",
					deadlineAt: null,
					providerId: "github",
					reason: "Provider upgraded",
					status: "PENDING_AUTHORIZATION",
					targetProviderReleaseId: "provider-v6",
					taskId: "task-upgrade",
				},
			];
			const response = await api.createAuthorizationPreview();
			response.preview.actions = actions;
			api.createAuthorizationPreview.mockResolvedValueOnce(response);
			api.getConnections.mockResolvedValueOnce(overview);
			renderPage(<ConnectionsPage />);
			if (entry === "upgrade") {
				fireEvent.click(
					await screen.findByRole("button", { name: "确认授权" }),
				);
			} else {
				fireEvent.click(
					await screen.findByRole("button", { name: /GitHub 已连接/ }),
				);
				fireEvent.click(screen.getByRole("button", { name: "授权客户端" }));
			}
			fireEvent.click(screen.getByRole("button", { name: "查看授权内容" }));
			await screen.findByText(`已选择 ${count} / 共 15 项`);
			for (const [index, action] of actions.entries()) {
				expect(
					(
						screen.getByRole("checkbox", {
							name: `${action.name} ${action.effect === "READ" ? "读取" : "写入"}`,
						}) as HTMLInputElement
					).checked,
				).toBe(index < count);
			}
		},
	);

	it("连接页调用 Jira Server credential API", async () => {
		renderPage(<ConnectionsPage />);
		await screen.findByRole("heading", { name: "客户端授权" });

		fireEvent.click(screen.getByRole("button", { name: "Jira 未连接" }));
		fireEvent.click(screen.getByRole("button", { name: "连接" }));
		fireEvent.change(screen.getByLabelText("Jira 用户名"), {
			target: { value: "guoxianzhe@agora.io" },
		});
		fireEvent.change(screen.getByLabelText("Jira 密码"), {
			target: { value: "jira-password" },
		});
		fireEvent.click(screen.getByRole("button", { name: "连接" }));
		await waitFor(() =>
			expect(api.connectProviderCredential).toHaveBeenCalledOnce(),
		);
		expect(calls(api.connectProviderCredential)[0]?.[0]).toEqual({
			password: "jira-password",
			providerId: "jira",
			username: "guoxianzhe@agora.io",
		});
	});

	it("连接页调用 Jenkins deployment credential API", async () => {
		renderPage(<ConnectionsPage />);
		await screen.findByRole("heading", { name: "客户端授权" });

		fireEvent.click(
			screen.getByRole("button", { name: /Jenkins Release 已连接/ }),
		);
		fireEvent.click(screen.getByRole("button", { name: "再连接" }));
		fireEvent.change(screen.getByLabelText("Jenkins 用户名"), {
			target: { value: "jenkins-user" },
		});
		fireEvent.change(screen.getByLabelText("Jenkins API Token"), {
			target: { value: "jenkins-api-token" },
		});
		fireEvent.click(screen.getByRole("button", { name: "连接" }));
		await waitFor(() =>
			expect(api.connectProviderCredential).toHaveBeenCalledOnce(),
		);
		expect(calls(api.connectProviderCredential)[0]?.[0]).toEqual({
			apiToken: "jenkins-api-token",
			providerId: "jenkins-release",
			username: "jenkins-user",
		});
	});

	it("连接页调用 Rehoboam credential API", async () => {
		renderPage(<ConnectionsPage />);
		await screen.findByRole("heading", { name: "客户端授权" });

		fireEvent.click(screen.getByRole("button", { name: "Rehoboam 未连接" }));
		fireEvent.click(screen.getByRole("button", { name: "连接" }));
		fireEvent.change(screen.getByLabelText("Rehoboam PAT"), {
			target: { value: "rehoboam-personal-pat" },
		});
		fireEvent.click(screen.getByRole("button", { name: "连接" }));
		await waitFor(() =>
			expect(api.connectProviderCredential).toHaveBeenCalledOnce(),
		);
		expect(calls(api.connectProviderCredential)[0]?.[0]).toEqual({
			accessToken: "rehoboam-personal-pat",
			providerId: "rehoboam",
		});
	});

	it("连接页使用浏览器会话调用 DataLego credential API", async () => {
		renderPage(<ConnectionsPage />);
		await screen.findByRole("heading", { name: "客户端授权" });

		fireEvent.click(screen.getByRole("button", { name: "DataLego 未连接" }));
		fireEvent.click(screen.getByRole("button", { name: "连接" }));
		await waitFor(() =>
			expect(api.connectProviderCredential).toHaveBeenCalledOnce(),
		);
		expect(calls(api.connectProviderCredential)[0]?.[0]).toEqual({
			providerId: "datalego",
		});
	});

	it("断开的 Connection 不显示在已连接账号列表", async () => {
		renderPage(<ConnectionsPage />);
		await screen.findByRole("heading", { name: "客户端授权" });

		fireEvent.click(screen.getByRole("button", { name: "DataLego 未连接" }));
		expect(
			screen.getByRole("heading", { name: "还没有 DataLego Connection" }),
		).toBeTruthy();
		expect(screen.queryByText("Disconnected DataLego")).toBeNull();
		expect(screen.queryByText("old@example.invalid")).toBeNull();
	});

	it("连接页调用 Jenkins CI credential API", async () => {
		renderPage(<ConnectionsPage />);
		await screen.findByRole("heading", { name: "客户端授权" });

		fireEvent.click(screen.getByRole("button", { name: "Jenkins CI 未连接" }));
		fireEvent.click(screen.getByRole("button", { name: "连接" }));
		fireEvent.change(screen.getByLabelText("Jenkins 用户名"), {
			target: { value: "jenkins-ci-user" },
		});
		fireEvent.change(screen.getByLabelText("Jenkins API Token"), {
			target: { value: "jenkins-ci-api-token" },
		});
		fireEvent.click(screen.getByRole("button", { name: "连接" }));
		await waitFor(() =>
			expect(api.connectProviderCredential).toHaveBeenCalledOnce(),
		);
		expect(calls(api.connectProviderCredential)[0]?.[0]).toEqual({
			apiToken: "jenkins-ci-api-token",
			providerId: "jenkins-ci",
			username: "jenkins-ci-user",
		});
	});

	it("连接页调用 Confluence Server credential API", async () => {
		renderPage(<ConnectionsPage />);
		await screen.findByRole("heading", { name: "客户端授权" });

		fireEvent.click(screen.getByRole("button", { name: /Confluence 已连接/ }));
		fireEvent.click(screen.getByRole("button", { name: "再连接" }));
		fireEvent.change(screen.getByLabelText("Confluence 密码"), {
			target: { value: "confluence-password" },
		});
		fireEvent.click(screen.getByRole("button", { name: "连接" }));
		await waitFor(() =>
			expect(api.connectProviderCredential).toHaveBeenCalledOnce(),
		);
		expect(calls(api.connectProviderCredential)[0]?.[0]).toEqual({
			password: "confluence-password",
			providerId: "confluence",
			username: "guoxianzhe@agora.io",
		});
	});

	it("历史授权不允许再次撤销", async () => {
		const overview = await api.getConnections();
		const grant = overview.overview.grants[0];
		if (!grant) throw new Error("测试需要至少一条 Grant");
		grant.status = "REVOKED";
		api.getConnections.mockResolvedValueOnce(overview);

		renderPage(<ConnectionsPage />);
		await screen.findByRole("heading", { name: "客户端授权" });
		fireEvent.click(screen.getByRole("checkbox", { name: "显示历史授权" }));
		const revokeButton = screen.getByRole("button", { name: "撤销 Codex" });
		expect((revokeButton as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(revokeButton);
		expect(api.revokeGrant).not.toHaveBeenCalled();
	});

	it("默认隐藏历史授权并支持切换查看", async () => {
		const overview = await api.getConnections();
		const grant = overview.overview.grants[0];
		if (!grant) throw new Error("测试需要至少一条 Grant");
		overview.overview.grants.push({
			...grant,
			consumerId: "consumer-history",
			consumerName: "历史 Codex",
			id: "grant-history",
			status: "REVOKED",
		});
		api.getConnections.mockResolvedValueOnce(overview);

		renderPage(<ConnectionsPage />);
		await screen.findByRole("heading", { name: "客户端授权" });
		expect(screen.queryByText("历史 Codex")).toBeNull();
		fireEvent.click(screen.getByRole("checkbox", { name: "显示历史授权" }));
		expect(screen.getByText("历史 Codex")).toBeTruthy();
	});

	it("同一连接器下切换账号时只显示该账号的客户端授权", async () => {
		const overview = await api.getConnections();
		overview.overview.connections.push({
			actionVersionIds: [
				"github.get_repository@v8",
				"github.get_pull_request@v7",
				"github.list_repositories@v8",
			],
			displayName: "AgoraIO-Extensions",
			externalAccount: "agora-release-bot",
			id: "connection-github-shared",
			ownerType: "PERSONAL",
			providerId: "github",
			requiresReconnect: false,
			status: "ACTIVE",
		});
		overview.overview.grants.push({
			actionVersionIds: ["github.get_repository@v2"],
			actions: [
				{
					effect: "READ",
					id: "github.get_repository@v2",
					name: "github.get_repository",
				},
			],
			connectionDisplayName: "AgoraIO-Extensions",
			connectionId: "connection-github-shared",
			consumerId: "consumer-rehoboam-ai",
			consumerName: "RehoboamAI",
			externalAccount: "agora-release-bot",
			id: "grant-rehoboam-shared",
			providerId: "github",
			status: "ACTIVE",
		});
		api.getConnections.mockResolvedValueOnce(overview);

		renderPage(<ConnectionsPage />);
		fireEvent.click(
			await screen.findByRole("button", {
				name: /AgoraIO-Extensions agora-release-bot/,
			}),
		);

		expect(
			screen.getByRole("heading", { name: "AgoraIO-Extensions" }),
		).toBeTruthy();
		expect(screen.getByText("RehoboamAI")).toBeTruthy();
		expect(screen.queryByText("Codex")).toBeNull();
		expect(screen.getByText("授权版本 v7, v8")).toBeTruthy();
	});

	it("Token 页面调用签发和撤销 API", async () => {
		vi.spyOn(window, "confirm").mockReturnValue(true);
		renderPage(<TokensPage />);
		await screen.findByText("现有 Token");
		fireEvent.change(screen.getByLabelText("客户端"), {
			target: { value: "consumer-rehoboam-ai" },
		});
		fireEvent.change(screen.getByLabelText("令牌名称"), {
			target: { value: "Codex 本机" },
		});
		fireEvent.submit(screen.getByRole("button", { name: "签发令牌" }));
		await waitFor(() => expect(api.issueToken).toHaveBeenCalledOnce());
		expect(calls(api.issueToken)[0]?.[0]).toEqual({
			consumerId: "consumer-rehoboam-ai",
			name: "Codex 本机",
		});
		fireEvent.click(screen.getByRole("button", { name: "撤销 现有 Token" }));
		await waitFor(() => expect(api.revokeToken).toHaveBeenCalledOnce());
		expect(calls(api.revokeToken)[0]?.[0]).toBe("token-existing");
	});

	it("管理员页面调用授予和撤销 API", async () => {
		renderPage(<AdministratorsPage />);
		await screen.findByText("user@agora.io");
		expect(await screen.findByText(/connection-v6/)).toBeTruthy();
		expect(screen.getByText("2 / 5")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "设为管理员" }));
		fireEvent.click(screen.getByRole("button", { name: "移除管理员" }));
		await waitFor(() => expect(api.grantAdministrator).toHaveBeenCalledOnce());
		expect(calls(api.grantAdministrator)[0]?.[0]).toBe("principal-user");
		await waitFor(() => expect(api.revokeAdministrator).toHaveBeenCalledOnce());
		expect(calls(api.revokeAdministrator)[0]?.[0]).toBe("principal-admin");
	});

	it("共享页面调用全部共享管理 API", async () => {
		const open = vi.spyOn(window, "open");
		renderPage(<SharedConnectionsPage />);
		await screen.findByText("声网研发");

		fireEvent.change(
			document.querySelector("#scope-name") as HTMLInputElement,
			{
				target: { value: "中国研发" },
			},
		);
		fireEvent.submit(screen.getByRole("button", { name: "创建共享组" }));
		fireEvent.click(screen.getByRole("button", { name: "连接 GitHub" }));
		fireEvent.click(screen.getByRole("button", { name: "授予资格" }));
		fireEvent.click(screen.getByRole("button", { name: "移除资格" }));
		fireEvent.click(screen.getByRole("button", { name: "断开 Shared GitHub" }));
		fireEvent.click(screen.getByText("改名"));
		fireEvent.change(
			document.querySelector("#rename-scope-company") as HTMLInputElement,
			{ target: { value: "发布工程" } },
		);
		fireEvent.submit(screen.getByRole("button", { name: "保存" }));

		await waitFor(() => expect(api.createSharedScope).toHaveBeenCalledOnce());
		expect(calls(api.createSharedScope)[0]?.[0]).toBe("中国研发");
		expect(calls(api.startGithubOAuth)[0]?.[0]).toBe("scope-company");
		expect(open).not.toHaveBeenCalled();
		expect(api.grantSharedScopePrincipal).toHaveBeenCalledWith(
			"scope-company",
			"principal-candidate",
		);
		expect(api.revokeSharedScopePrincipal).toHaveBeenCalledWith(
			"scope-company",
			"principal-member",
		);
		expect(calls(api.disconnectSharedConnection)[0]?.[0]).toBe(
			"connection-shared",
		);
		expect(api.renameSharedScope).toHaveBeenCalledWith(
			"scope-company",
			"发布工程",
		);
	});
});
