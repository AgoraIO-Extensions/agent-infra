// @vitest-environment jsdom

import type { AuthorizationPreviewResponse } from "@agent-infra/connection-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionApiError, connectionApi } from "../api";
import { PreviewContent } from "./connections-page";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function fixture(): AuthorizationPreviewResponse {
	return {
		idempotencyKey: "discovery-key",
		preview: {
			previewId: "discovery",
			confirmationToken: "discovery-token",
			consumer: { id: "consumer", name: "Codex" },
			targetConnection: {
				id: "connection",
				displayName: "GitHub",
				externalAccount: "account",
			},
			actions: [
				{
					id: "read@v2",
					name: "read",
					effect: "READ",
					description: "Read details",
					requiredScopes: ["read"],
				},
				{
					id: "write@v2",
					name: "write",
					effect: "WRITE",
					description: "Write details",
					requiredScopes: ["write"],
				},
			],
			effectSummary: ["READ", "WRITE"],
			requiredScopes: ["read", "write"],
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		},
	};
}

function selectedPreview(
	ids: string[],
	id = "final",
): AuthorizationPreviewResponse {
	const value = fixture();
	return {
		...value,
		idempotencyKey: `${id}-key`,
		preview: {
			...value.preview,
			previewId: id,
			confirmationToken: `${id}-token`,
			actions: value.preview.actions.filter((action) =>
				ids.includes(action.id),
			),
		},
	};
}

function mount(
	overrides: Partial<ComponentProps<typeof PreviewContent>> = {},
	respond = async (input: { actionVersionIds?: string[] }) =>
		selectedPreview(input.actionVersionIds ?? []),
) {
	const preview = vi
		.spyOn(connectionApi, "createAuthorizationPreview")
		.mockImplementation(respond);
	const props = {
		busy: false,
		value: fixture(),
		onConfirm: vi.fn(),
		onCancel: vi.fn(),
		onRefresh: vi.fn(),
		...overrides,
	};
	render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			<PreviewContent {...props} />
		</QueryClientProvider>,
	);
	return { props, preview };
}

async function ready() {
	await waitFor(() =>
		expect(
			(screen.getByRole("button", { name: "确认授权" }) as HTMLButtonElement)
				.disabled,
		).toBe(false),
	);
	return screen.getByRole("button", { name: "确认授权" });
}

describe("single-dialog authorization", () => {
	it("prepares exact selections automatically and shows inline changes and scopes", async () => {
		const { props, preview } = mount({
			initialActions: [{ id: "read@v1", name: "read", effect: "READ" }],
		});
		await ready();
		expect(props.onConfirm).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("checkbox", { name: "write 写入" }));
		fireEvent.click(screen.getByRole("checkbox", { name: "read 读取" }));
		expect(screen.getByText("新增授权 1 项，取消授权 1 项")).toBeTruthy();
		expect(screen.getByText("Write details")).toBeTruthy();
		expect(screen.getByText("所需 scope：write")).toBeTruthy();
		fireEvent.click(await ready());
		expect(preview).toHaveBeenLastCalledWith({
			connectionId: "connection",
			consumerId: "consumer",
			actionVersionIds: ["write@v2"],
		});
		expect(props.onConfirm).toHaveBeenCalledWith(
			expect.objectContaining({
				idempotencyKey: "final-key",
				preview: expect.objectContaining({
					previewId: "final",
					actions: [expect.objectContaining({ id: "write@v2" })],
				}),
			}),
		);
		expect(screen.queryByText("查看授权差异")).toBeNull();
	});

	it("ignores a late preview for an earlier selection", async () => {
		let resolveOld!: (value: AuthorizationPreviewResponse) => void;
		let resolveNew!: (value: AuthorizationPreviewResponse) => void;
		const { props } = mount(
			{},
			(input) =>
				new Promise((resolve) => {
					if (input.actionVersionIds?.length === 1) resolveOld = resolve;
					else resolveNew = resolve;
				}),
		);
		fireEvent.click(screen.getByRole("checkbox", { name: "write 写入" }));
		await act(async () =>
			resolveNew(selectedPreview(["read@v2", "write@v2"], "new")),
		);
		await ready();
		await act(async () => resolveOld(selectedPreview(["read@v2"], "old")));
		fireEvent.click(await ready());
		expect(props.onConfirm).toHaveBeenCalledWith(
			expect.objectContaining({ idempotencyKey: "new-key" }),
		);
	});

	it("blocks double submission and retries the same token after a network error", async () => {
		let reject!: (reason: Error) => void;
		const confirm = vi.fn().mockImplementationOnce(
			() =>
				new Promise((_, rejectPromise) => {
					reject = rejectPromise;
				}),
		);
		mount({ onConfirm: confirm });
		const button = await ready();
		fireEvent.click(button);
		fireEvent.click(button);
		expect(confirm).toHaveBeenCalledTimes(1);
		await act(async () => reject(new Error("Network failed")));
		await screen.findByText("Network failed");
		fireEvent.click(await ready());
		expect(confirm).toHaveBeenCalledTimes(2);
		expect(confirm.mock.calls[1]?.[0]).toEqual(confirm.mock.calls[0]?.[0]);
	});

	it("refreshes an expired preview but requires a new explicit click", async () => {
		const expired = selectedPreview(["read@v2"], "expired");
		expired.preview.expiresAt = new Date(Date.now() - 1).toISOString();
		const { props, preview } = mount({}, async () => expired);
		const button = await ready();
		preview.mockResolvedValueOnce(selectedPreview(["read@v2"], "fresh"));
		fireEvent.click(button);
		await ready();
		expect(props.onConfirm).not.toHaveBeenCalled();
		fireEvent.click(await ready());
		expect(props.onConfirm).toHaveBeenCalledWith(
			expect.objectContaining({ idempotencyKey: "fresh-key" }),
		);
	});

	it.each([
		"effect",
		"scope",
		"account",
		"currentAccount",
		"description",
		"consumer",
	])("rejects changed %s facts without silent consent", async (field) => {
		const changed = selectedPreview(["read@v2"]);
		const action = changed.preview.actions[0];
		if (!action) throw new Error("Action required");
		if (field === "effect") action.effect = "WRITE";
		if (field === "scope") action.requiredScopes = ["admin"];
		if (field === "description") action.description = "Changed purpose";
		if (field === "account")
			changed.preview.targetConnection.externalAccount = "other";
		if (field === "currentAccount")
			changed.preview.currentConnection = {
				id: "other",
				externalAccount: "other",
				displayName: "Other",
			};
		if (field === "consumer") changed.preview.consumer.id = "other";
		const { props } = mount({}, async () => changed);
		await screen.findByText("授权内容已变化，请刷新后重新确认。");
		expect(
			(screen.getByRole("button", { name: "确认授权" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "刷新授权内容" }));
		expect(props.onRefresh).toHaveBeenCalledOnce();
		expect(props.onConfirm).not.toHaveBeenCalled();
	});

	it("requires refresh after the server rejects a stale confirmation", async () => {
		const confirm = vi.fn().mockRejectedValue(
			new ConnectionApiError({
				code: "INVALID_REQUEST",
				messageKey: "connection.error.invalid_request",
				retryable: false,
				traceId: "test",
			}),
		);
		const { props } = mount({ onConfirm: confirm });
		fireEvent.click(await ready());
		await screen.findByText("授权内容已变化，请刷新后重新确认。");
		expect(
			(screen.getByRole("button", { name: "确认授权" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "刷新授权内容" }));
		expect(props.onRefresh).toHaveBeenCalledOnce();
		expect(confirm).toHaveBeenCalledOnce();
	});

	it("retries a failed final preview without confirming or losing selections", async () => {
		const { props, preview } = mount({}, async () => {
			throw new Error("Preview unavailable");
		});
		await screen.findByText("Preview unavailable");
		preview.mockResolvedValueOnce(selectedPreview(["read@v2"]));
		fireEvent.click(screen.getByRole("button", { name: "重试" }));
		await ready();
		expect(screen.getByText("已选择 1 / 共 2 项")).toBeTruthy();
		expect(props.onConfirm).not.toHaveBeenCalled();
	});

	it("offers rediscovery when final preview selection is no longer valid", async () => {
		const { props } = mount({}, async () => {
			throw new ConnectionApiError({
				code: "INVALID_REQUEST",
				messageKey: "connection.error.invalid_request",
				retryable: false,
				traceId: "test",
			});
		});
		await screen.findByText("授权内容已变化，请刷新后重新确认。");
		fireEvent.click(screen.getByRole("button", { name: "刷新授权内容" }));
		expect(props.onRefresh).toHaveBeenCalledOnce();
		expect(props.onConfirm).not.toHaveBeenCalled();
	});
});
