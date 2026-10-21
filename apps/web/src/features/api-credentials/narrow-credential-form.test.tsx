import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { PersonalApiCredentialMetadataV1 } from "../../pilot/generated-v2/types.gen.js";
import { NarrowCredentialForm } from "./narrow-credential-form.js";

const metadata: PersonalApiCredentialMetadataV1 = {
	credentialId: "credential-narrow",
	createdAt: "2026-10-01T00:00:00Z",
	expiresAt: "2026-11-01T00:00:00Z",
	lastUsedAt: null,
	revokedAt: null,
	scopes: ["agent:read", "agent:use"],
};

// 收窄表单的复选框名称带凭证标识（C2-19），与签发区的同名权限区分。
const readScope = `读取 Agent：${metadata.credentialId}`;
const useScope = `使用 Agent：${metadata.credentialId}`;

function setup(credential = metadata) {
	vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-10T00:00:00Z"));
	const onNarrow = vi.fn().mockResolvedValue(undefined);
	const onComplete = vi.fn();
	const onCancel = vi.fn();
	render(
		<NarrowCredentialForm
			credential={credential}
			onNarrow={onNarrow}
			onComplete={onComplete}
			onCancel={onCancel}
		/>,
	);
	return { onNarrow, onComplete, onCancel };
}

function submit() {
	fireEvent.click(screen.getByRole("button", { name: "保存收窄" }));
}

describe("NarrowCredentialForm", () => {
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("offers only current scopes, focuses the first checkbox and sends a nonempty subset", async () => {
		const { onNarrow, onComplete } = setup();
		expect(screen.getAllByRole("checkbox")).toHaveLength(2);
		expect(screen.queryByLabelText("管理 Agent")).toBeNull();
		expect(document.activeElement).toBe(
			screen.getByRole("checkbox", { name: readScope }),
		);
		fireEvent.click(screen.getByRole("checkbox", { name: useScope }));
		submit();
		await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
		expect(onNarrow).toHaveBeenCalledWith(metadata.credentialId, {
			scopes: ["agent:read"],
		});
	});

	it("names each checkbox with the credential so it differs from the issue form (C2-19)", () => {
		setup();
		expect(screen.getAllByRole("checkbox")).toEqual([
			screen.getByRole("checkbox", { name: readScope }),
			screen.getByRole("checkbox", { name: useScope }),
		]);
		expect(screen.queryByRole("checkbox", { name: "读取 Agent" })).toBeNull();
		// 可见标签仍是权限文字，可访问名称以它开头（Label in Name）；点击标签仍切换复选框。
		const label = screen.getByText("使用 Agent", { selector: "label" });
		expect(label.textContent).toBe("使用 Agent");
		fireEvent.click(label);
		expect(
			screen
				.getByRole("checkbox", { name: useScope })
				.getAttribute("aria-checked"),
		).toBe("false");
	});

	it("rejects an empty subset with errors associated with both checkboxes", () => {
		const { onNarrow } = setup();
		fireEvent.click(screen.getByRole("checkbox", { name: readScope }));
		fireEvent.click(screen.getByRole("checkbox", { name: useScope }));
		submit();
		const error = screen.getByText("至少保留一项当前权限。");
		for (const checkbox of screen.getAllByRole("checkbox")) {
			expect(checkbox.getAttribute("aria-invalid")).toBe("true");
			expect(checkbox.getAttribute("aria-describedby")).toBe(
				error.closest("[role=alert]")?.id,
			);
		}
		expect(onNarrow).not.toHaveBeenCalled();
	});

	it.each([
		metadata.expiresAt,
		"2026-12-01T00:00",
		"2026-10-10T00:00",
		"2026-01-01T00:00",
		"999999-01-01T00:00",
	])("rejects a non-future, invalid or non-earlier expiry: %s", (value) => {
		const { onNarrow } = setup();
		// The input uses local time, so preserve the exact current expiry for the equal boundary.
		const localValue =
			value !== null && value === metadata.expiresAt
				? new Date(
						new Date(value).getTime() -
							new Date(value).getTimezoneOffset() * 60_000,
					)
						.toISOString()
						.slice(0, 16)
				: value;
		fireEvent.change(screen.getByLabelText("提前到期时间（可选）"), {
			target: { value: localValue },
		});
		submit();
		const input = screen.getByLabelText("提前到期时间（可选）");
		const error = screen.getByText(
			"请选择未来的有效时间，且早于当前过期时间。",
		);
		expect(input.getAttribute("aria-describedby")).toBe(
			error.closest("[role=alert]")?.id,
		);
		expect(input.getAttribute("aria-invalid")).toBe("true");
		expect(document.activeElement).toBe(input);
		expect(onNarrow).not.toHaveBeenCalled();
	});

	it.each([metadata.expiresAt, null])(
		"can introduce or shorten expiry without changing scopes: %s",
		async (expiry) => {
			const { onNarrow } = setup({ ...metadata, expiresAt: expiry });
			const localTime = "2026-10-20T12:30";
			fireEvent.change(screen.getByLabelText("提前到期时间（可选）"), {
				target: { value: localTime },
			});
			submit();
			await waitFor(() =>
				expect(onNarrow).toHaveBeenCalledWith(metadata.credentialId, {
					expiresAt: new Date(localTime).toISOString(),
				}),
			);
		},
	);

	it("keeps blank expiry unchanged and refuses an unchanged request", () => {
		const { onNarrow } = setup();
		submit();
		expect(screen.getByText(/请减少权限或设置更早/)).toBeTruthy();
		expect(onNarrow).not.toHaveBeenCalled();
	});

	it("keeps a rejected request retryable without announcing success", async () => {
		const { onNarrow, onComplete } = setup();
		onNarrow.mockRejectedValueOnce(
			Object.assign(new Error("Rejected"), { code: "AUTHORIZATION_REVOKED" }),
		);
		fireEvent.click(screen.getByRole("checkbox", { name: useScope }));
		submit();
		await waitFor(() =>
			expect(screen.getByText(/当前账号无权修改/)).toBeTruthy(),
		);
		expect(onComplete).not.toHaveBeenCalled();
		submit();
		await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
		expect(onNarrow.mock.calls[0]).toEqual(onNarrow.mock.calls[1]);
	});

	it("keeps refresh feedback while syncing a readback that arrives during a request", async () => {
		// 该用例不经过 setup()，同样固定当前时间，避免输入的到期时间随真实日期过期（#2513）。
		const now = vi
			.spyOn(Date, "now")
			.mockReturnValue(Date.parse("2026-10-10T00:00:00Z"));
		onTestFinished(() => now.mockRestore());
		const onRefresh = vi.fn();
		const onComplete = vi.fn();
		const onCancel = vi.fn();
		const initialMetadata: PersonalApiCredentialMetadataV1 = {
			...metadata,
			scopes: ["agent:read", "agent:use", "agent:manage"],
		};
		let rejectNarrow: (reason: unknown) => void = () => undefined;
		const onNarrow = vi.fn(
			() =>
				new Promise<never>((_resolve, reject) => {
					rejectNarrow = reject;
				}),
		);
		const view = render(
			<NarrowCredentialForm
				credential={initialMetadata}
				onNarrow={onNarrow}
				onComplete={onComplete}
				onCancel={onCancel}
				onRefresh={onRefresh}
			/>,
		);

		fireEvent.click(screen.getByRole("checkbox", { name: useScope }));
		fireEvent.click(screen.getByRole("checkbox", { name: readScope }));
		fireEvent.change(screen.getByLabelText("提前到期时间（可选）"), {
			target: { value: "2026-10-20T12:30" },
		});
		submit();
		await waitFor(() => expect(onNarrow).toHaveBeenCalledOnce());

		const refreshedMetadata: PersonalApiCredentialMetadataV1 = {
			...metadata,
			expiresAt: "2026-10-15T00:00:00Z",
			scopes: ["agent:read"],
		};
		view.rerender(
			<NarrowCredentialForm
				credential={refreshedMetadata}
				onNarrow={onNarrow}
				onComplete={onComplete}
				onCancel={onCancel}
				onRefresh={onRefresh}
			/>,
		);
		await waitFor(() =>
			expect(
				screen
					.getByRole("checkbox", { name: readScope })
					.getAttribute("aria-checked"),
			).toBe("true"),
		);
		expect(
			(screen.getByLabelText("提前到期时间（可选）") as HTMLInputElement).value,
		).toBe("");

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

	it("keeps drafts when readback returns equivalent scope values", () => {
		const view = render(
			<NarrowCredentialForm
				credential={metadata}
				onNarrow={vi.fn()}
				onComplete={vi.fn()}
				onCancel={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByRole("checkbox", { name: useScope }));
		fireEvent.change(screen.getByLabelText("提前到期时间（可选）"), {
			target: { value: "2026-10-20T12:30" },
		});

		view.rerender(
			<NarrowCredentialForm
				credential={{ ...metadata, scopes: [...metadata.scopes] }}
				onNarrow={vi.fn()}
				onComplete={vi.fn()}
				onCancel={vi.fn()}
			/>,
		);

		expect(
			screen
				.getByRole("checkbox", { name: useScope })
				.getAttribute("aria-checked"),
		).toBe("false");
		expect(
			(screen.getByLabelText("提前到期时间（可选）") as HTMLInputElement).value,
		).toBe("2026-10-20T12:30");
	});

	it("prevents concurrent submissions and keeps controls disabled through completion", async () => {
		const { onNarrow, onComplete } = setup();
		let finish: () => void = () => undefined;
		onNarrow.mockReturnValue(
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
		);
		fireEvent.click(screen.getByRole("checkbox", { name: useScope }));
		fireEvent.submit(screen.getByRole("form"));
		fireEvent.submit(screen.getByRole("form"));
		expect(onNarrow).toHaveBeenCalledOnce();
		expect(
			screen
				.getByRole("button", { name: "正在保存…" })
				.hasAttribute("disabled"),
		).toBe(true);
		expect(
			screen.getByRole("button", { name: "取消" }).hasAttribute("disabled"),
		).toBe(true);
		await act(async () => {
			finish();
		});
		expect(onComplete).toHaveBeenCalledOnce();
	});

	it("returns to the row without submitting when cancelled", () => {
		const { onNarrow, onCancel } = setup();
		fireEvent.click(screen.getByRole("button", { name: "取消" }));
		expect(onCancel).toHaveBeenCalledOnce();
		expect(onNarrow).not.toHaveBeenCalled();
	});
});
