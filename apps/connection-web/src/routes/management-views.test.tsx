// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ComponentProps, ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionApi } from "../api";
import { PreviewContent } from "../pages/connections-page";
import { SharedScopeSection } from "../pages/shared-connections-page";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function renderPreview(
	element: ReactElement<ComponentProps<typeof PreviewContent>>,
) {
	vi.spyOn(connectionApi, "createAuthorizationPreview").mockImplementation(
		async (input) => ({
			...element.props.value,
			preview: {
				...element.props.value.preview,
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
				actions: element.props.value.preview.actions.filter((action) =>
					input.actionVersionIds?.includes(action.id),
				),
			},
		}),
	);
	return render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			{element}
		</QueryClientProvider>,
	);
}

describe("Connection 管理交互", () => {
	it("批量选择当前筛选结果并清空 Grant 能力", async () => {
		const onConfirm = vi.fn();
		renderPreview(
			<PreviewContent
				busy={false}
				onConfirm={onConfirm}
				onCancel={vi.fn()}
				onRefresh={vi.fn()}
				value={{
					idempotencyKey: "idempotency-preview",
					preview: {
						actions: [
							{
								description: "读取仓库",
								effect: "READ",
								id: "github.get_repository@v8",
								name: "github.get_repository",
								requiredScopes: ["repo"],
							},
							{
								description: "创建议题",
								effect: "WRITE",
								id: "github.create_issue@v8",
								name: "github.create_issue",
								requiredScopes: ["repo"],
							},
							{
								description: "更新议题",
								effect: "WRITE",
								id: "github.update_issue@v8",
								name: "github.update_issue",
								requiredScopes: ["repo"],
							},
						],
						confirmationToken: "confirmation-token",
						consumer: { id: "consumer-codex", name: "Codex" },
						effectSummary: ["READ", "WRITE"],
						expiresAt: "2026-09-17T12:00:00.000Z",
						previewId: "preview-id",
						requiredScopes: ["repo"],
						targetConnection: {
							displayName: "GitHub",
							externalAccount: "AGORAconnectionE2E",
							id: "connection-id",
						},
					},
				}}
			/>,
		);

		expect(screen.getByText("已选择 1 / 共 3 项")).toBeTruthy();
		fireEvent.change(screen.getByRole("combobox", { name: "能力类型" }), {
			target: { value: "WRITE" },
		});
		fireEvent.click(screen.getByRole("button", { name: "选择当前结果" }));
		expect(screen.getByText("已选择 3 / 共 3 项")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "清空" }));
		expect(screen.getByText("已选择 0 / 共 3 项")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "选择当前结果" }));
		await waitFor(() =>
			expect(
				(screen.getByRole("button", { name: "确认授权" }) as HTMLButtonElement)
					.disabled,
			).toBe(false),
		);
		fireEvent.click(screen.getByRole("button", { name: "确认授权" }));
		expect(onConfirm).toHaveBeenCalledWith(
			expect.objectContaining({
				preview: expect.objectContaining({
					actions: [
						expect.objectContaining({ id: "github.create_issue@v8" }),
						expect.objectContaining({ id: "github.update_issue@v8" }),
					],
				}),
			}),
		);
	});

	it("授权确认显示账号、Consumer、外部效果和所需 scope", async () => {
		const onConfirm = vi.fn();
		renderPreview(
			<PreviewContent
				busy={false}
				onConfirm={onConfirm}
				onCancel={vi.fn()}
				onRefresh={vi.fn()}
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
		expect(screen.getByText("写入", { selector: "small" })).toBeTruthy();
		expect(screen.getByText("所需 scope：repo、workflow")).toBeTruthy();
		fireEvent.click(
			screen.getByRole("checkbox", { name: "github.create_pull_request 写入" }),
		);
		await waitFor(() =>
			expect(
				(screen.getByRole("button", { name: "确认授权" }) as HTMLButtonElement)
					.disabled,
			).toBe(false),
		);
		const confirmButton = screen.getByRole("button", { name: "确认授权" });
		expect(confirmButton.closest(".authorization-footer")).toBeTruthy();
		fireEvent.click(confirmButton);
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
