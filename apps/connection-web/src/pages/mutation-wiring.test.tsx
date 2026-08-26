// @vitest-environment jsdom

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
	createAuthorizationPreview: vi.fn(async () => ({
		idempotencyKey: "confirmation-idempotency-key",
		preview: {
			actions: [
				{
					description: "创建 Pull Request",
					effect: "WRITE" as const,
					id: "github.create_pull_request@v2",
					name: "github.create_pull_request",
					requiredScopes: ["repo"],
				},
			],
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
	})),
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
					actionVersionIds: [],
					displayName: "GitHub",
					externalAccount: "guoxianzhe",
					id: "connection-personal",
					ownerType: "PERSONAL" as const,
					requiresReconnect: false,
					status: "ACTIVE",
				},
				{
					actionVersionIds: [],
					displayName: "旧 GitHub",
					externalAccount: "guoxianzhe-old",
					id: "connection-old",
					ownerType: "PERSONAL" as const,
					requiresReconnect: true,
					status: "DISCONNECTED",
				},
			],
			consumers: [{ id: "consumer-codex", name: "Codex" }],
			grants: [
				{
					actionVersionIds: ["github.get_repository@v2"],
					consumerId: "consumer-codex",
					consumerName: "Codex",
					id: "grant-codex",
					status: "ACTIVE",
				},
			],
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
	listTokens: vi.fn(async () => ({
		tokens: [
			{
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
	it("连接页调用 GitHub、授权、断开和 Grant API", async () => {
		vi.spyOn(window, "confirm").mockReturnValue(true);
		const popup = {
			close: vi.fn(),
			location: { replace: vi.fn() },
			opener: null,
		};
		vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
		renderPage(<ConnectionsPage />);
		await screen.findByText("guoxianzhe");

		fireEvent.click(screen.getByRole("button", { name: "连接 GitHub" }));
		fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
		await waitFor(() => expect(api.startGithubOAuth).toHaveBeenCalledTimes(2));
		expect(calls(api.startGithubOAuth).map((call) => call[0])).toEqual([
			undefined,
			undefined,
		]);

		fireEvent.click(screen.getByRole("button", { name: "断开 GitHub" }));
		await waitFor(() =>
			expect(api.disconnectConnection).toHaveBeenCalledOnce(),
		);
		expect(calls(api.disconnectConnection)[0]?.[0]).toBe("connection-personal");
		fireEvent.click(screen.getByRole("button", { name: "撤销 Codex" }));
		await waitFor(() => expect(api.revokeGrant).toHaveBeenCalledOnce());
		expect(calls(api.revokeGrant)[0]?.[0]).toBe("grant-codex");

		fireEvent.click(screen.getByRole("button", { name: "授权客户端" }));
		fireEvent.click(screen.getByRole("button", { name: "查看授权内容" }));
		await screen.findByRole("button", { name: "确认授权" });
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

	it("Token 页面调用签发和撤销 API", async () => {
		vi.spyOn(window, "confirm").mockReturnValue(true);
		renderPage(<TokensPage />);
		await screen.findByText("现有 Token");
		fireEvent.change(screen.getByLabelText("令牌名称"), {
			target: { value: "Codex 本机" },
		});
		fireEvent.submit(screen.getByRole("button", { name: "签发令牌" }));
		await waitFor(() => expect(api.issueToken).toHaveBeenCalledOnce());
		expect(calls(api.issueToken)[0]?.[0]).toBe("Codex 本机");
		fireEvent.click(screen.getByRole("button", { name: "撤销 现有 Token" }));
		await waitFor(() => expect(api.revokeToken).toHaveBeenCalledOnce());
		expect(calls(api.revokeToken)[0]?.[0]).toBe("token-existing");
	});

	it("管理员页面调用授予和撤销 API", async () => {
		renderPage(<AdministratorsPage />);
		await screen.findByText("user@agora.io");
		fireEvent.click(screen.getByRole("button", { name: "设为管理员" }));
		fireEvent.click(screen.getByRole("button", { name: "移除管理员" }));
		await waitFor(() => expect(api.grantAdministrator).toHaveBeenCalledOnce());
		expect(calls(api.grantAdministrator)[0]?.[0]).toBe("principal-user");
		await waitFor(() => expect(api.revokeAdministrator).toHaveBeenCalledOnce());
		expect(calls(api.revokeAdministrator)[0]?.[0]).toBe("principal-admin");
	});

	it("共享页面调用全部共享管理 API", async () => {
		const popup = {
			close: vi.fn(),
			location: { replace: vi.fn() },
			opener: null,
		};
		vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
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
