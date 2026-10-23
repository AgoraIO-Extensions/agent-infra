import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileLimitsV1 } from "../../pilot/generated/index.js";
import { ConversationFilesBar } from "./conversation-context-bar.js";
import { ConversationFileTransferError } from "./conversation-file-transfer.js";
import {
	ConversationFilePicker,
	type ConversationUpload,
	preflightRejection,
} from "./conversation-files.js";
import {
	contentNotTextMessage,
	uploadFailure,
	uploadRowRetryable,
} from "./conversation-upload-rows.js";

afterEach(cleanup);

const limits: FileLimitsV1 = {
	schemaVersion: 1,
	revision: "1",
	expiresAt: "2099-01-01T00:00:00Z",
	mediaTypes: ["text/plain", "application/pdf"],
	maxBytes: 1024 * 1024,
};
const limitCopy = "支持 text/plain, application/pdf，单文件最大 1.0 MB";

function upload(
	localId: string,
	name: string,
	status: ConversationUpload["status"],
	extra: Partial<ConversationUpload> = {},
): ConversationUpload {
	return {
		localId,
		file: new File(["x"], name, { type: "text/plain" }),
		descriptor: null,
		projection: null,
		status,
		...(status === "failed" ? { error: "上传失败，请重试。" } : {}),
		...(status === "expired" ? { error: "上传授权已过期，请重试。" } : {}),
		...extra,
	};
}

function renderPicker(
	props: Partial<Parameters<typeof ConversationFilePicker>[0]> = {},
) {
	return render(
		<ConversationFilePicker
			attachmentsEnabled
			limits={limits}
			limitsError={false}
			uploads={[]}
			onSelect={() => undefined}
			onRemove={() => undefined}
			onRetry={() => undefined}
			{...props}
		/>,
	);
}

/** 有状态的调用方：移除与重试真正改变列表，验证卸载后的焦点去处。 */
function StatefulPicker({
	initial,
	limitsError = false,
}: {
	initial: ConversationUpload[];
	limitsError?: boolean;
}) {
	const input = createRef<HTMLTextAreaElement>();
	const [uploads, setUploads] = useState(initial);
	return (
		<>
			<ConversationFilePicker
				attachmentsEnabled
				limits={limitsError ? undefined : limits}
				limitsError={limitsError}
				uploads={uploads}
				onSelect={() => undefined}
				onRemove={(localId) =>
					setUploads((current) =>
						current.filter((item) => item.localId !== localId),
					)
				}
				onRetry={(localId) =>
					setUploads((current) =>
						current.map((item) =>
							item.localId === localId
								? { ...item, status: "uploading", error: undefined }
								: item,
						),
					)
				}
				fallbackFocus={input}
			/>
			<textarea ref={input} aria-label="消息" />
		</>
	);
}

describe("uploadFailure (#3267)", () => {
	it("keeps transient failures and expired grants retryable and stops on non-text content", () => {
		expect(uploadFailure(new ConversationFileTransferError(true))).toEqual({
			status: "expired",
			error: "上传授权已过期，请重试。",
			retryable: true,
		});
		expect(uploadFailure(new ConversationFileTransferError(false))).toEqual({
			status: "failed",
			error: "上传失败，请重试。",
			retryable: true,
		});
		expect(uploadFailure(new Error("network"))).toEqual({
			status: "failed",
			error: "上传失败，请重试。",
			retryable: true,
		});
		expect(
			uploadFailure(new ConversationFileTransferError(false, "content")),
		).toEqual({
			status: "failed",
			error: contentNotTextMessage,
			retryable: false,
		});
	});

	it("only offers a retry for failed rows that can be retried", () => {
		expect(uploadRowRetryable({ status: "failed" })).toBe(true);
		expect(uploadRowRetryable({ status: "expired" })).toBe(true);
		expect(uploadRowRetryable({ status: "failed", retryable: false })).toBe(
			false,
		);
		expect(uploadRowRetryable({ status: "uploading" })).toBe(false);
		expect(uploadRowRetryable({ status: "available" })).toBe(false);
	});
});

describe("preflightRejection", () => {
	it("rejects files over the size limit or outside the allowed media types", () => {
		expect(
			preflightRejection({ size: 2 * 1024 * 1024, type: "text/plain" }, limits),
		).toBe("文件超过 1.0 MB 限制。");
		expect(
			preflightRejection({ size: 10, type: "application/zip" }, limits),
		).toBe("当前 Agent 不支持此文件类型。");
		expect(preflightRejection({ size: 10, type: "" }, limits)).toBe(
			"当前 Agent 不支持此文件类型。",
		);
		expect(
			preflightRejection({ size: 10, type: "application/pdf" }, limits),
		).toBeUndefined();
	});
});

describe("ConversationFilesBar summary (#3267 N8-1-07)", () => {
	it("counts only retryable failures as 待重试 and the rest as 无法上传", () => {
		render(
			<ConversationFilesBar
				uploads={[
					upload("1", "a.txt", "available"),
					upload("2", "fail.txt", "failed"),
					upload("3", "expired.txt", "expired"),
					upload("4", "archive.zip", "failed", { retryable: false }),
				]}
				limitsError={false}
			>
				<p>内容</p>
			</ConversationFilesBar>,
		);
		expect(
			screen.getByRole("button", { name: /^会话文件/ }).textContent,
		).toContain("4 个文件 · 2 个待重试 · 1 个无法上传");
	});

	it("keeps the plain summary when nothing was rejected", () => {
		render(
			<ConversationFilesBar
				uploads={[upload("1", "a.txt", "available")]}
				limitsError={false}
			>
				<p>内容</p>
			</ConversationFilesBar>,
		);
		const summary = screen.getByRole("button", { name: /^会话文件/ });
		expect(summary.textContent).toContain("1 个文件 · 0 个待重试");
		expect(summary.textContent).not.toContain("无法上传");
	});
});

describe("ConversationFilePicker (#3267)", () => {
	it("offers 添加附件 with one static limit line and a distinct file input name", () => {
		renderPicker();
		const add = screen.getByRole("button", { name: "添加附件" });
		const limit = screen.getByText(limitCopy);
		expect(add.getAttribute("aria-describedby")).toBe(limit.id);
		expect(limit.closest('[role="status"], [role="alert"]')).toBeNull();
		// 隐藏的文件输入与可见按钮不同名（N-12）。
		expect(screen.getByLabelText("选择附件文件")).toBeTruthy();
		expect(screen.queryByLabelText("添加附件")).toBeNull();
		expect(screen.getAllByRole("button", { name: "添加附件" })).toHaveLength(1);
		// 唯一的 live region 是常驻的播报区，渲染时为空。
		expect(screen.getByRole("status").textContent).toBe("");
	});

	for (const [name, props, copy] of [
		["the limits are loading", { limits: undefined }, "正在读取文件限制…"],
		[
			"the limits are unavailable",
			{ limits: undefined, limitsError: true },
			"文件限制暂不可用，上传入口已关闭。",
		],
	] as const) {
		it(`keeps a single static line without the entry when ${name}`, () => {
			const { container } = renderPicker(props);
			const notice = screen.getByText(copy);
			expect(notice.closest('[role="status"], [role="alert"]')).toBeNull();
			expect(screen.queryByRole("button")).toBeNull();
			expect(screen.queryByLabelText("选择附件文件")).toBeNull();
			const picker = container.querySelector(
				'[data-testid="conversation-file-picker"]',
			);
			expect(
				[...(picker?.children ?? [])].map((node) => node.textContent),
			).toEqual([copy, ""]);
		});
	}

	it("renders nothing when the Agent does not accept attachments", () => {
		const { container } = renderPicker({ attachmentsEnabled: false });
		expect(container.textContent).toBe("");
	});

	it("shows the reason under each name and offers retry only for retryable failures", () => {
		renderPicker({
			uploads: [
				upload("1", "a.txt", "uploading"),
				upload("2", "b.txt", "available"),
				upload("3", "notes.txt", "failed"),
				upload("4", "notes.txt", "expired"),
				upload("5", "archive.zip", "failed", {
					error: "当前 Agent 不支持此文件类型。",
					retryable: false,
				}),
				upload("6", "latin1.txt", "failed", {
					error: contentNotTextMessage,
					retryable: false,
				}),
			],
		});
		const rows = screen.getAllByRole("listitem");
		expect(rows.map((row) => row.dataset.fileStatus)).toEqual([
			"uploading",
			"available",
			"failed",
			"expired",
			"failed",
			"failed",
		]);
		// 行内状态不是 live region，失败原因是行内 role="alert"。
		expect(rows[0]?.querySelector('[role="status"]')).toBeNull();
		expect(rows[0]?.textContent).toContain("上传中…");
		expect(rows[1]?.textContent).toContain("已上传");
		expect(
			screen.getAllByRole("alert").map((node) => node.textContent),
		).toEqual([
			"上传失败，请重试。",
			"上传授权已过期，请重试。",
			"当前 Agent 不支持此文件类型。",
			contentNotTextMessage,
		]);
		const names = screen
			.getAllByRole("button")
			.map(
				(button) =>
					button.getAttribute("aria-label") ?? button.textContent?.trim(),
			);
		// 同名文件按出现顺序区分；确定性失败只能移除，没有「重试」。
		expect(names).toEqual([
			"添加附件",
			"移除附件 a.txt",
			"移除附件 b.txt",
			"重试：notes.txt（第 1 次）",
			"移除附件 notes.txt（第 1 次）",
			"重试：notes.txt（第 2 次）",
			"移除附件 notes.txt（第 2 次）",
			"移除附件 archive.zip",
			"移除附件 latin1.txt",
		]);
	});

	it("keeps the local image thumbnail on the row", () => {
		const { container } = renderPicker({
			uploads: [
				upload("1", "screen.png", "uploading", { previewUrl: "blob:x" }),
			],
		});
		expect(container.querySelector("li img")?.getAttribute("src")).toBe(
			"blob:x",
		);
	});

	it("moves focus to the row's remove button after retrying and to 添加附件 after removing", () => {
		render(
			<StatefulPicker
				initial={[
					upload("1", "a.txt", "available"),
					upload("2", "b.txt", "failed"),
				]}
			/>,
		);
		const retry = screen.getByRole("button", { name: "重试：b.txt" });
		retry.focus();
		fireEvent.click(retry);
		expect(screen.queryByRole("button", { name: "重试：b.txt" })).toBeNull();
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "移除附件 b.txt" }),
		);
		expect(screen.getByRole("status").textContent).toBe("b.txt 上传中…");
		const remove = screen.getByRole("button", { name: "移除附件 a.txt" });
		remove.focus();
		fireEvent.click(remove);
		expect(screen.queryByText("a.txt")).toBeNull();
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "添加附件" }),
		);
		expect(screen.getByRole("status").textContent).toBe("已移除 a.txt");
	});

	it("returns focus to the message input when 添加附件 is gone", () => {
		render(
			<StatefulPicker
				initial={[upload("1", "a.txt", "available")]}
				limitsError
			/>,
		);
		expect(screen.queryByRole("button", { name: "添加附件" })).toBeNull();
		const remove = screen.getByRole("button", { name: "移除附件 a.txt" });
		remove.focus();
		fireEvent.click(remove);
		expect(screen.queryByRole("listitem")).toBeNull();
		expect(document.activeElement).toBe(screen.getByLabelText("消息"));
	});

	it("forwards chosen files and clears the input for the next choice", () => {
		const onSelect = vi.fn();
		renderPicker({ onSelect });
		const input = screen.getByLabelText("选择附件文件") as HTMLInputElement;
		const file = new File(["x"], "a.txt", { type: "text/plain" });
		fireEvent.change(input, { target: { files: [file] } });
		expect(onSelect).toHaveBeenCalledWith([file]);
		expect(input.value).toBe("");
	});
});
