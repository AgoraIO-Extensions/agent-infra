// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewContent } from "../pages/connections-page";
import { SharedScopeSection } from "../pages/shared-connections-page";

afterEach(cleanup);

describe("Connection 管理交互", () => {
	it("授权确认显示账号、Consumer、外部效果和所需 scope", () => {
		const onConfirm = vi.fn();
		render(
			<PreviewContent
				busy={false}
				onConfirm={onConfirm}
				value={{
					idempotencyKey: "idempotency-preview",
					preview: {
						actions: [
							{
								description: "创建 Pull Request",
								effect: "WRITE",
								id: "github.create_pull_request@v2",
								name: "github.create_pull_request",
								requiredScopes: ["repo", "workflow"],
							},
						],
						confirmationToken: "confirmation-token",
						consumer: { id: "consumer-codex", name: "Codex" },
						effectSummary: ["WRITE"],
						expiresAt: "2026-08-26T12:00:00.000Z",
						previewId: "preview-id",
						requiredScopes: ["repo", "workflow"],
						targetConnection: {
							displayName: "GitHub",
							externalAccount: "guoxianzhe",
							id: "connection-id",
						},
					},
				}}
			/>,
		);

		expect(screen.getByText("guoxianzhe")).toBeTruthy();
		expect(screen.getByText("Codex")).toBeTruthy();
		expect(screen.getByText("写入")).toBeTruthy();
		expect(screen.getByText("所需 scope：repo、workflow")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "确认授权" }));
		expect(onConfirm).toHaveBeenCalledOnce();
	});

	it("共享组按钮分别触发连接、改名、成员资格和断开操作", () => {
		const handlers = {
			onConnect: vi.fn(),
			onDisconnect: vi.fn(),
			onGrant: vi.fn(),
			onRename: vi.fn(),
			onRevoke: vi.fn(),
		};
		render(
			<SharedScopeSection
				{...handlers}
				principals={[
					{
						displayName: "郭贤哲",
						email: "guoxianzhe@agora.io",
						principalId: "principal-user",
					},
				]}
				scope={{
					connections: [
						{
							displayName: "Agora GitHub",
							externalAccount: "agora-release-bot",
							id: "connection-shared",
							status: "ACTIVE",
						},
					],
					displayName: "声网研发",
					members: [],
					sharedScopeId: "scope-company",
					state: "ACTIVE",
				}}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "连接 GitHub" }));
		expect(handlers.onConnect).toHaveBeenCalledOnce();
		fireEvent.click(screen.getByRole("button", { name: "授予资格" }));
		expect(handlers.onGrant).toHaveBeenCalledWith("principal-user");
		fireEvent.click(screen.getByRole("button", { name: "断开 Agora GitHub" }));
		expect(handlers.onDisconnect).toHaveBeenCalledWith("connection-shared");

		fireEvent.click(screen.getByText("改名"));
		fireEvent.change(screen.getByLabelText("共享组名称"), {
			target: { value: "中国研发" },
		});
		const renameForm = screen
			.getByRole("button", { name: "保存" })
			.closest("form");
		expect(renameForm).toBeTruthy();
		if (!renameForm) throw new Error("保存按钮必须位于表单内");
		fireEvent.submit(renameForm);
		expect(handlers.onRename).toHaveBeenCalledWith("中国研发");
	});
});
