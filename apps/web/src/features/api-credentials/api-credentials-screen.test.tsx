import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
			screen.getAllByRole("button", { name: "收窄权限与有效期" }),
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
				screen.queryByRole("button", { name: "收窄权限与有效期" }),
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
		const button = screen.getByRole("button", { name: "收窄权限与有效期" });
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
		expect(document.activeElement).toBe(button);
	});
});
