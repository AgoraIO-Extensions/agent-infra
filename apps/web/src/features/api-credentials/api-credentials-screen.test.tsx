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
		fireEvent.click(trigger);
		dialog = await screen.findByRole("dialog");
		fireEvent.keyDown(dialog, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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
		const rows = screen.getAllByRole("listitem");
		expect(within(rows[0]).getByText("有效")).toBeTruthy();
		expect(within(rows[0]).getByText("永不过期")).toBeTruthy();
		expect(within(rows[0]).getByText("尚未使用")).toBeTruthy();
		expect(within(rows[1]).getByText("已过期")).toBeTruthy();
		expect(within(rows[2]).getByText("已撤销")).toBeTruthy();
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
				{ name: /^使用 Agent$/ },
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
		fireEvent.click(within(form).getByRole("checkbox", { name: "读取 Agent" }));
		fireEvent.click(within(form).getByRole("checkbox", { name: "使用 Agent" }));
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
					.getByRole("checkbox", { name: "读取 Agent" })
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
});
