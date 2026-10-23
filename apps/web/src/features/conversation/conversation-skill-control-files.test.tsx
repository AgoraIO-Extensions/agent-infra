import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileLimitsV1 } from "../../pilot/generated/index.js";
import type { SkillControlFileEntry } from "./conversation-skill-control-file-model.js";
import {
	SkillControlFilePicker,
	type SkillControlFilePickerProps,
} from "./conversation-skill-control-files.js";

afterEach(cleanup);

const limits: FileLimitsV1 = {
	schemaVersion: 1,
	revision: "1",
	expiresAt: "2027-01-01T00:00:00Z",
	mediaTypes: ["text/plain"],
	maxBytes: 4096,
};
const limitCopy =
	"仅支持 text/plain 文本文件，最多 4 个，单个文件不超过 4096 字节。";

function entry(
	localId: string,
	name: string,
	status: SkillControlFileEntry["status"],
): SkillControlFileEntry {
	return {
		localId,
		file: new File(["x"], name, { type: "text/plain" }),
		status,
		...(status === "available" ? { fileId: `file-${localId}` } : {}),
		...(status === "failed" ? { error: "上传失败，请重试。" } : {}),
		...(status === "expired" ? { error: "上传授权已过期，请重试。" } : {}),
	};
}

function renderPicker(props: Partial<SkillControlFilePickerProps> = {}) {
	const textarea = createRef<HTMLTextAreaElement>();
	const view = render(
		<>
			<SkillControlFilePicker
				attachmentsEnabled
				limits={limits}
				limitsError={false}
				entries={[]}
				onSelect={() => undefined}
				onRemove={() => undefined}
				onRetry={() => undefined}
				textarea={textarea}
				{...props}
			/>
			<textarea ref={textarea} aria-label="消息" />
		</>,
	);
	return { ...view, textarea };
}

/** 有状态的调用方：移除与重试真正改变列表，验证卸载后的焦点去处。 */
function StatefulPicker({
	initial,
	attachmentsEnabled = true,
	limitsError = false,
}: {
	initial: SkillControlFileEntry[];
	attachmentsEnabled?: boolean;
	limitsError?: boolean;
}) {
	const textarea = createRef<HTMLTextAreaElement>();
	const [entries, setEntries] = useState(initial);
	return (
		<>
			<SkillControlFilePicker
				attachmentsEnabled={attachmentsEnabled}
				limits={limits}
				limitsError={limitsError}
				entries={entries}
				onSelect={() => undefined}
				onRemove={(localId) =>
					setEntries((current) =>
						current.filter((item) => item.localId !== localId),
					)
				}
				onRetry={(localId) =>
					setEntries((current) =>
						current.map((item) =>
							item.localId === localId
								? { ...item, status: "uploading", error: undefined }
								: item,
						),
					)
				}
				textarea={textarea}
			/>
			<textarea ref={textarea} aria-label="消息" />
		</>
	);
}

describe("SkillControlFilePicker (#3259)", () => {
	it("offers the upload entry with one limit line and no live region on static copy", () => {
		renderPicker();
		expect(screen.getByText("Skill 控制文件")).toBeTruthy();
		const add = screen.getByRole("button", { name: "添加文本文件" });
		const limit = screen.getByText(limitCopy);
		expect(add.getAttribute("aria-describedby")).toBe(limit.id);
		expect(limit.closest('[role="status"], [role="alert"]')).toBeNull();
		// 唯一的 live region 是常驻的播报区，渲染时为空。
		expect(screen.getByRole("status").textContent).toBe("");
		expect(screen.queryByRole("alert")).toBeNull();
	});

	for (const [name, props, copy] of [
		[
			"the Agent does not accept attachments",
			{ attachmentsEnabled: false, limits: undefined },
			"当前 Agent 不支持上传控制文件，只能提交任务说明。",
		],
		[
			"the limits are still loading",
			{ limits: undefined },
			"正在读取文件限制…",
		],
		[
			"the limits are unavailable",
			{ limits: undefined, limitsError: true },
			"文件限制暂不可用，上传入口已关闭。",
		],
	] as const) {
		it(`keeps a single static line when ${name}`, () => {
			const { container } = renderPicker(props);
			const notice = screen.getByText(copy);
			expect(notice.closest('[role="status"], [role="alert"]')).toBeNull();
			expect(screen.queryByText("Skill 控制文件")).toBeNull();
			expect(screen.queryByText(limitCopy)).toBeNull();
			expect(screen.queryByRole("button")).toBeNull();
			expect(screen.queryByLabelText("添加 Skill 控制文件")).toBeNull();
			// 区块内只有这一行可见文字与空的播报区。
			const picker = container.querySelector(
				'[data-testid="skill-control-file-picker"]',
			);
			expect(
				[...(picker?.children ?? [])].map((node) => node.textContent),
			).toEqual([copy, ""]);
		});
	}

	it("shows each file with its status and names the row actions after the file", () => {
		renderPicker({
			entries: [
				entry("1", "a.txt", "uploading"),
				entry("2", "b.txt", "available"),
				entry("3", "notes.txt", "failed"),
				entry("4", "notes.txt", "expired"),
			],
		});
		const rows = screen.getAllByRole("listitem");
		expect(rows.map((row) => row.dataset.fileStatus)).toEqual([
			"uploading",
			"available",
			"failed",
			"expired",
		]);
		expect(rows[0]?.textContent).toContain("上传中…");
		expect(rows[1]?.textContent).toContain("已上传");
		expect(
			screen.getAllByRole("alert").map((node) => node.textContent),
		).toEqual(["上传失败，请重试。", "上传授权已过期，请重试。"]);
		// 同名文件按出现顺序区分，同页没有同名控件（N-12）。
		const names = screen
			.getAllByRole("button")
			.map(
				(button) =>
					button.getAttribute("aria-label") ?? button.textContent?.trim(),
			);
		expect(names).toEqual([
			"添加文本文件",
			"移除控制文件 a.txt",
			"移除控制文件 b.txt",
			"重试：notes.txt（第 1 次）",
			"移除控制文件 notes.txt（第 1 次）",
			"重试：notes.txt（第 2 次）",
			"移除控制文件 notes.txt（第 2 次）",
		]);
	});

	it("announces upload status changes and removals only once they happen", () => {
		const { rerender, textarea } = renderPicker();
		const status = screen.getByRole("status");
		const props = {
			attachmentsEnabled: true,
			limits,
			limitsError: false,
			onSelect: () => undefined,
			onRemove: () => undefined,
			onRetry: () => undefined,
			textarea,
		};
		rerender(
			<SkillControlFilePicker
				{...props}
				entries={[entry("1", "a.txt", "uploading")]}
			/>,
		);
		expect(status.textContent).toBe("a.txt 上传中…");
		rerender(
			<SkillControlFilePicker
				{...props}
				entries={[entry("1", "a.txt", "available")]}
			/>,
		);
		expect(status.textContent).toBe("a.txt 已上传");
		// 失败由行内 role="alert" 播报，播报区不重复。
		rerender(
			<SkillControlFilePicker
				{...props}
				entries={[
					entry("1", "a.txt", "available"),
					entry("2", "b.txt", "failed"),
				]}
			/>,
		);
		expect(status.textContent).toBe("a.txt 已上传");
		expect(screen.getByRole("alert").textContent).toBe("上传失败，请重试。");
	});

	it("does not announce files that already exist when the block mounts again", () => {
		renderPicker({
			entries: [
				entry("1", "a.txt", "available"),
				entry("2", "b.txt", "uploading"),
			],
		});
		expect(screen.getByRole("status").textContent).toBe("");
	});

	it("returns focus to 添加文本文件 after removing and keeps it on the row after retrying", () => {
		render(
			<StatefulPicker
				initial={[
					entry("1", "a.txt", "available"),
					entry("2", "b.txt", "failed"),
				]}
			/>,
		);
		const retry = screen.getByRole("button", { name: "重试：b.txt" });
		retry.focus();
		fireEvent.click(retry);
		expect(screen.queryByRole("button", { name: "重试：b.txt" })).toBeNull();
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "移除控制文件 b.txt" }),
		);
		const remove = screen.getByRole("button", { name: "移除控制文件 a.txt" });
		remove.focus();
		fireEvent.click(remove);
		expect(screen.queryByText("a.txt")).toBeNull();
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "添加文本文件" }),
		);
		expect(screen.getByRole("status").textContent).toBe("已移除 a.txt");
	});

	it("returns focus to the message input when the upload entry is gone", () => {
		render(
			<StatefulPicker
				initial={[entry("1", "a.txt", "available")]}
				limitsError
			/>,
		);
		expect(screen.queryByRole("button", { name: "添加文本文件" })).toBeNull();
		const remove = screen.getByRole("button", { name: "移除控制文件 a.txt" });
		remove.focus();
		fireEvent.click(remove);
		expect(screen.queryByRole("listitem")).toBeNull();
		expect(document.activeElement).toBe(screen.getByLabelText("消息"));
	});

	it("forwards chosen files and clears the input for the next choice", () => {
		const onSelect = vi.fn();
		renderPicker({ onSelect });
		const input = screen.getByLabelText(
			"添加 Skill 控制文件",
		) as HTMLInputElement;
		const file = new File(["x"], "a.txt", { type: "text/plain" });
		fireEvent.change(input, { target: { files: [file] } });
		expect(onSelect).toHaveBeenCalledWith([file]);
		expect(input.value).toBe("");
	});
});
