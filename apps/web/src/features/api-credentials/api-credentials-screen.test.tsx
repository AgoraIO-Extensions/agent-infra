import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type {
	IssuePersonalApiCredentialV2Responses,
	PersonalApiCredentialMetadataV1,
} from "../../pilot/generated-v2/types.gen.js";
import { ApiCredentialsScreen } from "./api-credentials-screen.js";

const metadata: PersonalApiCredentialMetadataV1 = {
	credentialId: "credential-1",
	createdAt: "2026-10-10T00:00:00Z",
	expiresAt: null,
	lastUsedAt: null,
	revokedAt: null,
	scopes: ["agent:read"],
};

describe("ApiCredentialsScreen", () => {
	afterEach(cleanup);

	it("renders metadata without exposing credential material", () => {
		render(
			<ApiCredentialsScreen
				state={{ kind: "ready", credentials: [metadata] }}
			/>,
		);

		expect(screen.getByText("credential-1")).toBeTruthy();
		expect(screen.queryByText(/papi_/)).toBeNull();
	});

	it("offers 重新登录 for a 401 list read and no other recovery (N9-3-04)", () => {
		const onRelogin = vi.fn();
		const onRetry = vi.fn();
		const view = render(
			<ApiCredentialsScreen
				state={{
					kind: "unavailable",
					retryable: false,
					reason: "authentication-required",
				}}
				onRetry={onRetry}
				onRelogin={onRelogin}
			/>,
		);
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toBe(
			"登录状态已失效，请重新登录后再试。重新登录",
		);
		const relogin = within(alert).getByRole("button", { name: "重新登录" });
		fireEvent.click(relogin);
		expect(onRelogin).toHaveBeenCalledOnce();
		expect(onRetry).not.toHaveBeenCalled();
		// 确认会话期间保持可聚焦的禁用（aria-disabled），不落到 body。
		view.rerender(
			<ApiCredentialsScreen
				state={{
					kind: "unavailable",
					retryable: false,
					reason: "authentication-required",
				}}
				onRetry={onRetry}
				onRelogin={onRelogin}
				retrying
			/>,
		);
		expect(relogin.getAttribute("aria-disabled")).toBe("true");
		expect((relogin as HTMLButtonElement).disabled).toBe(false);
		// 403 等其余不可重试失败仍只说明原因。
		view.rerender(
			<ApiCredentialsScreen
				state={{ kind: "unavailable", retryable: false, reason: "denied" }}
				onRetry={onRetry}
				onRelogin={onRelogin}
			/>,
		);
		expect(within(screen.getByRole("alert")).queryByRole("button")).toBeNull();
	});

	it("confirms a revocation with the credential and its consequence before requesting it", async () => {
		const second = { ...metadata, credentialId: "credential-2" };
		const onRevoke = vi
			.fn<(credentialId: string) => Promise<unknown>>()
			.mockResolvedValue(undefined);
		render(
			<ApiCredentialsScreen
				state={{ kind: "ready", credentials: [metadata, second] }}
				onRevoke={onRevoke}
			/>,
		);
		// 每张卡的撤销按钮可访问名称都带凭证标识，且不是实心 danger。
		const trigger = screen.getByRole("button", {
			name: "撤销：credential-1",
		});
		expect(
			screen.getByRole("button", { name: "撤销：credential-2" }),
		).toBeTruthy();
		expect(trigger.className).not.toContain("bg-destructive");
		fireEvent.click(trigger);
		let dialog = await screen.findByRole("dialog", {
			name: "撤销这张 API 凭证？",
		});
		expect(within(dialog).getByText("credential-1")).toBeTruthy();
		expect(within(dialog).getByText(/撤销后不能恢复/)).toBeTruthy();
		expect(onRevoke).not.toHaveBeenCalled();
		fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		// E3-15：取消与 Escape 关闭后焦点回到「撤销：{凭证}」触发按钮。
		await waitFor(() => expect(document.activeElement).toBe(trigger));
		fireEvent.click(trigger);
		dialog = await screen.findByRole("dialog");
		fireEvent.keyDown(dialog, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(trigger));
		expect(onRevoke).not.toHaveBeenCalled();
		fireEvent.click(trigger);
		dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "撤销凭证" }));
		expect(onRevoke).toHaveBeenCalledExactlyOnceWith("credential-1");
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		// 触发器在撤销进行中会禁用、成功后消失，焦点落在该凭证卡片内而不是 body。
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByText("credential-1", { selector: "code" }),
			),
		);
	});

	// E3-15：确认后撤销失败、触发按钮没有消失时，焦点从行标识交还「撤销：{凭证}」以便重试。
	it("returns focus to the revoke trigger when a confirmed revocation fails", async () => {
		let reject: (reason: unknown) => void = () => undefined;
		const onRevoke = vi.fn<(credentialId: string) => Promise<unknown>>(
			() =>
				new Promise((_resolve, rejectRevoke) => {
					reject = rejectRevoke;
				}),
		);
		render(
			<ApiCredentialsScreen
				state={{ kind: "ready", credentials: [metadata] }}
				onRevoke={onRevoke}
			/>,
		);
		const trigger = screen.getByRole("button", {
			name: "撤销：credential-1",
		});
		fireEvent.click(trigger);
		const dialog = await screen.findByRole("dialog", {
			name: "撤销这张 API 凭证？",
		});
		fireEvent.click(within(dialog).getByRole("button", { name: "撤销凭证" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		const label = screen.getByText("credential-1", { selector: "code" });
		await waitFor(() => expect(document.activeElement).toBe(label));
		await act(async () => reject(new Error("synthetic revoke failure")));
		await waitFor(() => expect(document.activeElement).toBe(trigger));
		expect(onRevoke).toHaveBeenCalledExactlyOnceWith("credential-1");
	});

	it("shows first-delivery material once and explains replay behavior", async () => {
		const onIssue = vi
			.fn<
				(body: {
					scopes: (typeof metadata.scopes)[number][];
					expiresAt: string | null;
				}) => Promise<IssuePersonalApiCredentialV2Responses[201]>
			>()
			.mockResolvedValue({
				credential: "papi_1234567890123456789012345678901234567890123",
				metadata,
				replayed: false,
			});
		render(
			<ApiCredentialsScreen
				state={{ kind: "ready", credentials: [] }}
				onIssue={onIssue}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "签发个人凭证" }));
		await waitFor(() => expect(screen.getByText(/papi_/)).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: "关闭一次性凭证提示" }));
		fireEvent.click(screen.getByRole("button", { name: "签发个人凭证" }));
		await waitFor(() => expect(onIssue).toHaveBeenCalledTimes(2));
	});
	it("distinguishes expired, revoked and non-expiring metadata", () => {
		const onNarrow = vi.fn();
		render(
			<ApiCredentialsScreen
				state={{
					kind: "ready",
					credentials: [
						metadata,
						{
							...metadata,
							credentialId: "expired",
							expiresAt: "2020-01-01T00:00:00Z",
						},
						{
							...metadata,
							credentialId: "revoked",
							revokedAt: "2026-10-01T00:00:00Z",
							expiresAt: "2020-01-01T00:00:00Z",
						},
					],
				}}
				onNarrow={onNarrow}
			/>,
		);
		// 凭证列表是表格（R-02），首行为表头。
		const table = screen.getByRole("table", { name: "个人 API 凭证" });
		const rows = within(table).getAllByRole("row").slice(1);
		expect(
			within(table)
				.getAllByRole("columnheader")
				.map((cell) => cell.textContent),
		).toEqual(["名称", "主体", "范围", "状态", "有效期", "操作"]);
		expect(within(rows[0]).getByText("有效")).toBeTruthy();
		expect(within(rows[0]).getByText("永不过期")).toBeTruthy();
		expect(within(rows[0]).getByText("尚未使用")).toBeTruthy();
		expect(within(rows[1]).getByText("已过期")).toBeTruthy();
		// 已撤销行：状态 chip 为「已撤销」，有效期列只显示撤销时间，
		// 不提供详情、轮换或收窄（#2862 R-02，PRD §7.3）。
		expect(
			within(rows[2]).getByText("已撤销", { selector: '[data-slot="badge"]' }),
		).toBeTruthy();
		const revokedCell = within(rows[2])
			.getAllByRole("cell")
			.find((cell) => cell.dataset.label === "有效期");
		expect(revokedCell?.textContent).toMatch(/^已撤销于 /);
		expect(revokedCell?.querySelector("time")?.getAttribute("datetime")).toBe(
			"2026-10-01T00:00:00Z",
		);
		expect(
			within(rows[2]).queryByRole("button", { name: /详情|轮换|收窄/ }),
		).toBeNull();
		expect(
			screen.getAllByRole("button", { name: /^收窄权限与有效期：/ }),
		).toHaveLength(1);
	});

	it("updates the expiry state while the page stays open", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
			render(
				<ApiCredentialsScreen
					state={{
						kind: "ready",
						credentials: [{ ...metadata, expiresAt: "2026-10-10T00:00:01Z" }],
					}}
					onNarrow={vi.fn()}
				/>,
			);
			expect(screen.getByText("有效")).toBeTruthy();
			act(() => vi.advanceTimersByTime(1000));
			expect(screen.getByText("已过期")).toBeTruthy();
			expect(
				screen.queryByRole("button", { name: /^收窄权限与有效期/ }),
			).toBeNull();
		} finally {
			cleanup();
			vi.useRealTimers();
		}
	});

	it("announces only a completed narrow and restores focus to its row action", async () => {
		render(
			<ApiCredentialsScreen
				state={{
					kind: "ready",
					credentials: [{ ...metadata, scopes: ["agent:read", "agent:use"] }],
				}}
				onNarrow={vi.fn().mockResolvedValue(undefined)}
			/>,
		);
		const button = screen.getByRole("button", {
			name: `收窄权限与有效期：${metadata.credentialId}`,
		});
		fireEvent.click(button);
		fireEvent.click(
			within(screen.getByRole("form", { name: /收窄凭证/ })).getByRole(
				"checkbox",
				{ name: `使用 Agent：${metadata.credentialId}` },
			),
		);
		fireEvent.click(screen.getByRole("button", { name: "保存收窄" }));
		await waitFor(() =>
			expect(screen.getByText("凭证已收窄，已读取最新元数据。")).toBeTruthy(),
		);
		expect(screen.queryByRole("form", { name: /收窄凭证/ })).toBeNull();
		await waitFor(() => expect(document.activeElement).toBe(button));
	});

	it("keeps narrow failure feedback when a parent readback updates the row", async () => {
		// 固定当前时间，避免 fixture 中写死的到期时间随真实日期过期（#2513）。
		const now = vi
			.spyOn(Date, "now")
			.mockReturnValue(Date.parse("2026-10-10T00:00:00Z"));
		onTestFinished(() => now.mockRestore());
		const initialMetadata: PersonalApiCredentialMetadataV1 = {
			...metadata,
			expiresAt: "2026-11-01T00:00:00Z",
			scopes: ["agent:read", "agent:use", "agent:manage"],
		};
		const refreshedMetadata: PersonalApiCredentialMetadataV1 = {
			...initialMetadata,
			expiresAt: "2026-10-15T00:00:00Z",
			scopes: ["agent:read"],
		};
		const onRefresh = vi.fn();
		let rejectNarrow: (reason: unknown) => void = () => undefined;
		const onNarrow = vi.fn(
			() =>
				new Promise<never>((_resolve, reject) => {
					rejectNarrow = reject;
				}),
		);
		const view = render(
			<ApiCredentialsScreen
				state={{ kind: "ready", credentials: [initialMetadata] }}
				onNarrow={onNarrow}
				onRetry={onRefresh}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", {
				name: `收窄权限与有效期：${metadata.credentialId}`,
			}),
		);
		const form = screen.getByRole("form", { name: /收窄凭证/ });
		fireEvent.click(
			within(form).getByRole("checkbox", {
				name: `读取 Agent：${metadata.credentialId}`,
			}),
		);
		fireEvent.click(
			within(form).getByRole("checkbox", {
				name: `使用 Agent：${metadata.credentialId}`,
			}),
		);
		fireEvent.click(within(form).getByRole("button", { name: "保存收窄" }));
		await waitFor(() => expect(onNarrow).toHaveBeenCalledOnce());

		view.rerender(
			<ApiCredentialsScreen
				state={{ kind: "ready", credentials: [refreshedMetadata] }}
				onNarrow={onNarrow}
				onRetry={onRefresh}
			/>,
		);
		await waitFor(() =>
			expect(
				within(screen.getByRole("form", { name: /收窄凭证/ }))
					.getByRole("checkbox", {
						name: `读取 Agent：${metadata.credentialId}`,
					})
					.getAttribute("aria-checked"),
			).toBe("true"),
		);

		await act(async () => {
			rejectNarrow(Object.assign(new Error("Conflict"), { code: "CONFLICT" }));
		});
		await waitFor(() =>
			expect(screen.getByText(/凭证状态已变化/)).toBeTruthy(),
		);
		expect(
			screen
				.getByRole("button", { name: "重新加载凭证" })
				.hasAttribute("disabled"),
		).toBe(false);
		fireEvent.click(screen.getByRole("button", { name: "重新加载凭证" }));
		expect(onRefresh).toHaveBeenCalledOnce();
	});

	it("renders the design page head, notice and credential table (R-02)", () => {
		const onCreate = vi.fn();
		const longId = "personal-credential-0123456789";
		render(
			<ApiCredentialsScreen
				state={{
					kind: "ready",
					credentials: [
						{
							...metadata,
							credentialId: longId,
							scopes: ["agent:read", "agent:use"],
							expiresAt: "2099-12-31T00:00:00Z",
						},
						{
							...metadata,
							credentialId: "expired",
							expiresAt: "2020-01-01T00:00:00Z",
						},
						{
							...metadata,
							credentialId: "revoked",
							revokedAt: "2026-10-01T00:00:00Z",
						},
					],
				}}
				subjectName="凭证管理员"
				onCreateApplicationCredential={onCreate}
				onNarrow={vi.fn()}
				onRevoke={vi.fn()}
			/>,
		);
		expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
		expect(
			screen.getByRole("heading", { level: 1, name: "API 凭证" }),
		).toBeTruthy();
		expect(screen.getByText("我的管理 / API 凭证")).toBeTruthy();
		expect(
			screen.getByText("管理个人和应用凭证的范围、有效期与撤销状态。"),
		).toBeTruthy();
		expect(
			screen.getByRole("heading", { level: 2, name: "签发个人凭证" }),
		).toBeTruthy();
		expect(document.body.textContent).not.toMatch(/安全设置|userId/);
		const notice = screen
			.getByText("凭证值不会回显")
			.closest('[data-slot="alert"]') as HTMLElement;
		expect(notice.getAttribute("role")).toBeNull();
		expect(
			within(notice).getByText(
				"本页只展示元数据；发放、轮换和接收者授权由服务端校验。",
			),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "创建应用凭证" }));
		expect(onCreate).toHaveBeenCalledOnce();

		const table = screen.getByRole("table", { name: "个人 API 凭证" });
		expect(table.className).toContain("credential-table");
		const [active, expired, revoked] = within(table)
			.getAllByRole("row")
			.slice(1);
		// 完整 ID 只出现在 title 与可访问名称里，可见文字是缩写。
		expect(table.textContent).not.toContain(longId);
		expect(within(active as HTMLElement).getByText("个人凭证")).toBeTruthy();
		expect(within(active as HTMLElement).getByTitle(longId).textContent).toBe(
			"personal…",
		);
		expect(within(active as HTMLElement).getByText("凭证管理员")).toBeTruthy();
		expect(
			within(active as HTMLElement).getByText("agent:read · agent:use"),
		).toBeTruthy();
		const tone = (row: HTMLElement, text: string) =>
			within(row)
				.getByText(text, { selector: '[data-slot="badge"]' })
				.getAttribute("data-tone");
		expect(tone(active as HTMLElement, "有效")).toBe("green");
		expect(tone(expired as HTMLElement, "已过期")).toBe("amber");
		expect(tone(revoked as HTMLElement, "已撤销")).toBe("red");
		expect(
			within(active as HTMLElement)
				.getByRole("button", { name: `收窄权限与有效期：${longId}` })
				.getAttribute("data-slot"),
		).toBe("button");
		expect(screen.queryByRole("button", { name: /轮换|查看详情/ })).toBeNull();
		// 同页还有应用凭证表单：分组与过期时间的名称带对象（N-12）。
		expect(
			screen.getByRole("group", { name: "权限范围：个人凭证" }),
		).toBeTruthy();
		expect(screen.getByLabelText("过期时间（可选）：个人凭证")).toBeTruthy();
	});
});
