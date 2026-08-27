// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectionsView, LoginView, Status, TokensView } from "./views";

afterEach(cleanup);

describe("Connection Web 中文界面", () => {
	it("显示中文登录表单和错误提示", () => {
		const onSubmit = vi.fn();
		render(
			<LoginView busy={false} error="账号或密码错误" onSubmit={onSubmit} />,
		);

		expect(
			screen.getByRole("heading", { name: "登录 Connection" }),
		).toBeTruthy();
		expect(screen.getByLabelText("公司账号")).toBeTruthy();
		expect(screen.getByRole("alert").textContent).toBe("账号或密码错误");
		const loginForm = screen
			.getByRole("button", { name: "登录" })
			.closest("form");
		expect(loginForm).toBeTruthy();
		if (!loginForm) throw new Error("登录按钮必须位于表单内");
		fireEvent.submit(loginForm);
		expect(onSubmit).toHaveBeenCalledOnce();
	});

	it("只在签发响应中显示一次 Token 明文并连接交互回调", () => {
		const onIssue = vi.fn();
		const onRevoke = vi.fn();
		const { rerender } = render(
			<TokensView
				busy={false}
				issued={null}
				onIssue={onIssue}
				onRevoke={onRevoke}
				tokens={[
					{
						createdAt: "2026-08-25T00:00:00.000Z",
						expiresAt: "2026-11-23T00:00:00.000Z",
						lastUsedAt: null,
						name: "Codex 本机",
						status: "ACTIVE",
						tokenId: "pat-1",
					},
				]}
			/>,
		);

		expect(screen.queryByText(/conn_pat_/)).toBeNull();
		const issueForm = screen
			.getByRole("button", { name: "签发令牌" })
			.closest("form");
		expect(issueForm).toBeTruthy();
		if (!issueForm) throw new Error("签发按钮必须位于表单内");
		fireEvent.submit(issueForm);
		expect(onIssue).toHaveBeenCalledOnce();
		fireEvent.click(screen.getByRole("button", { name: "撤销 Codex 本机" }));
		expect(onRevoke).toHaveBeenCalledWith("pat-1");

		rerender(
			<TokensView
				busy={false}
				issued={{
					expiresAt: "2026-11-23T00:00:00.000Z",
					name: "Codex 本机",
					token: "conn_pat_one_time_secret",
				}}
				onIssue={onIssue}
				onRevoke={onRevoke}
				tokens={[]}
			/>,
		);
		expect(screen.getByText(/只显示一次/)).toBeTruthy();
		expect(screen.getByText("conn_pat_one_time_secret")).toBeTruthy();
	});

	it("区分个人和共享 Connection", () => {
		render(
			<ConnectionsView
				connections={[
					{
						actionVersionIds: [],
						displayName: "GitHub",
						externalAccount: "guoxianzhe",
						id: "personal",
						ownerType: "PERSONAL",
						providerId: "github",
						requiresReconnect: false,
						status: "ACTIVE",
					},
					{
						actionVersionIds: [],
						displayName: "Agora Bitbucket",
						externalAccount: "agora-release-bot",
						id: "shared",
						ownerType: "SHARED",
						providerId: "bitbucket",
						requiresReconnect: false,
						status: "ACTIVE",
					},
				]}
				onAuthorize={() => undefined}
				onDisconnect={() => undefined}
				onReconnect={() => undefined}
			/>,
		);

		expect(screen.getByText("个人")).toBeTruthy();
		expect(screen.getByText("共享")).toBeTruthy();
		expect(screen.getAllByText("GitHub").length).toBeGreaterThanOrEqual(2);
		expect(screen.getByText("Bitbucket")).toBeTruthy();
	});

	it("把所有 Grant 状态显示为中文", () => {
		render(
			<>
				<Status value="PAUSED_CONNECTION" />
				<Status value="PAUSED_CREDENTIAL" />
				<Status value="REPLACED" />
			</>,
		);
		expect(screen.getByText("Connection 已暂停")).toBeTruthy();
		expect(screen.getByText("凭证已暂停")).toBeTruthy();
		expect(screen.getByText("已被替换")).toBeTruthy();
		expect(document.body.textContent).not.toContain("PAUSED_");
		expect(document.body.textContent).not.toContain("REPLACED");
	});
});
