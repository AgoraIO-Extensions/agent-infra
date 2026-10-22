import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PersistedConversationEventV2Schema } from "@agent-infra/contracts/pilot";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantMarkdown } from "./assistant-markdown.js";
import type { ResultFile } from "./conversation-files.js";
import { event } from "./conversation-test-fixtures.js";
import type { SandboxReferences } from "./sandbox-reference-views.js";
import {
	executionResultFiles,
	sandboxReferenceIndex,
} from "./sandbox-references.js";

const chart: ResultFile = {
	fileId: "file-chart",
	executionId: "execution-1",
	name: "chart.png",
	mediaType: "image/png",
	sizeBytes: 3,
	workspaceReference: "out/chart.png",
};
const report: ResultFile = {
	fileId: "file-report",
	executionId: "execution-1",
	name: "r.pdf",
	mediaType: "application/pdf",
	sizeBytes: 2048,
	workspaceReference: "r.pdf",
};
const archive: ResultFile = {
	fileId: "file-archive",
	executionId: "execution-1",
	name: "bundle.zip",
	mediaType: "application/zip",
	sizeBytes: 4096,
	workspaceReference: "out/bundle.zip",
};
const large: ResultFile = {
	fileId: "file-large",
	executionId: "execution-1",
	name: "large.png",
	mediaType: "image/png",
	sizeBytes: 2 * 1024 * 1024,
	workspaceReference: "large.png",
};

function references(
	changes: Partial<SandboxReferences> = {},
	files: readonly ResultFile[] = [chart, report, archive, large],
) {
	const content = new Blob(["png"], { type: "image/png" });
	const readImage = vi.fn(async () => content);
	const onPreview = vi.fn();
	const onDownload = vi.fn();
	return {
		content,
		readImage,
		onPreview,
		onDownload,
		value: {
			files: sandboxReferenceIndex(files),
			settled: true,
			readImage,
			onPreview,
			onDownload,
			...changes,
		} satisfies SandboxReferences,
	};
}

const fetchSpy = vi.fn(async () => new Response(null, { status: 599 }));
const originalFetch = globalThis.fetch;
const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;

beforeEach(() => {
	fetchSpy.mockClear();
	globalThis.fetch = fetchSpy as unknown as typeof fetch;
	let next = 0;
	Object.defineProperty(URL, "createObjectURL", {
		configurable: true,
		value: vi.fn(() => `blob:inline-${++next}`),
	});
	Object.defineProperty(URL, "revokeObjectURL", {
		configurable: true,
		value: vi.fn(),
	});
});

afterEach(() => {
	cleanup();
	globalThis.fetch = originalFetch;
	Object.defineProperty(URL, "createObjectURL", {
		configurable: true,
		value: originalCreateObjectUrl,
	});
	Object.defineProperty(URL, "revokeObjectURL", {
		configurable: true,
		value: originalRevokeObjectUrl,
	});
});

describe("sandbox: references in assistant answers (#3228)", () => {
	it("shows a published image inline and a published file as a card, both previewable and downloadable (AC-1)", async () => {
		const { value, readImage, onPreview, onDownload, content } = references();
		render(
			<AssistantMarkdown references={value}>
				{
					"结果如下：\n\n![销量图](sandbox:out/chart.png)\n\n请查看[季度报告](sandbox:r.pdf)。"
				}
			</AssistantMarkdown>,
		);
		const image = await screen.findByRole<HTMLImageElement>("img", {
			name: "销量图",
		});
		expect(image.getAttribute("src")).toMatch(/^blob:inline-/);
		expect(readImage).toHaveBeenCalledTimes(1);
		expect(readImage).toHaveBeenCalledWith({ fileId: "file-chart" });
		fireEvent.click(screen.getByRole("button", { name: "预览图片：销量图" }));
		// 已读到的内存 Blob 直接交给现有预览，不再签发读取。
		expect(onPreview).toHaveBeenCalledWith(chart, content);
		expect(readImage).toHaveBeenCalledTimes(1);

		const card = screen.getByRole("group", { name: "结果文件：r.pdf" });
		expect(within(card).getByText("季度报告")).toBeTruthy();
		expect(within(card).getByText("r.pdf")).toBeTruthy();
		expect(within(card).getByText("application/pdf · 2 KB")).toBeTruthy();
		fireEvent.click(within(card).getByRole("button", { name: "预览：r.pdf" }));
		expect(onPreview).toHaveBeenLastCalledWith(report);
		fireEvent.click(within(card).getByRole("button", { name: "下载：r.pdf" }));
		expect(onDownload).toHaveBeenCalledWith(report);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("shows non-previewable files and images over the preview limit as download cards without reading them", () => {
		const { value, readImage } = references();
		render(
			<AssistantMarkdown references={value}>
				{"[打包结果](sandbox:out/bundle.zip)\n\n![大图](sandbox:large.png)"}
			</AssistantMarkdown>,
		);
		const zip = screen.getByRole("group", { name: "结果文件：bundle.zip" });
		expect(within(zip).queryByRole("button", { name: /^预览/ })).toBeNull();
		expect(
			within(zip).getByRole("button", { name: "下载：bundle.zip" }),
		).toBeTruthy();
		const big = screen.getByRole("group", { name: "结果文件：large.png" });
		expect(within(big).queryByRole("button", { name: /^预览/ })).toBeNull();
		expect(screen.queryByRole("img")).toBeNull();
		expect(readImage).not.toHaveBeenCalled();
	});

	it.each([
		"sandbox:out/chart.png",
		"sandbox:./out/chart.png",
		"sandbox:/out/chart.png",
		"sandbox:out/tmp/../chart.png",
		"sandbox:out%2Fchart.png",
	])("matches %s with the Runtime normalization", async (url) => {
		const { value, readImage } = references();
		render(
			<AssistantMarkdown
				references={value}
			>{`![图](${url})`}</AssistantMarkdown>,
		);
		expect(await screen.findByRole("img", { name: "图" })).toBeTruthy();
		expect(readImage).toHaveBeenCalledWith({ fileId: "file-chart" });
	});

	it("renders each referenced file once and keeps repeats as plain text", async () => {
		const { value, readImage } = references();
		const { container } = render(
			<AssistantMarkdown references={value}>
				{
					"![图一](sandbox:out/chart.png) 再看 ![图二](sandbox:./out/chart.png)，[原图](sandbox:/out/chart.png)。\n\n[报告](sandbox:r.pdf) 与 [同一报告](sandbox:r.pdf)\n\n![缺失](sandbox:missing.png) ![又缺失](sandbox:missing.png)"
				}
			</AssistantMarkdown>,
		);
		expect(await screen.findAllByRole("img")).toHaveLength(1);
		expect(readImage).toHaveBeenCalledTimes(1);
		expect(container.textContent).toContain("[图片：图二]");
		expect(container.textContent).toContain("原图");
		expect(
			screen.getAllByRole("group", { name: "结果文件：r.pdf" }),
		).toHaveLength(1);
		expect(container.textContent).toContain("同一报告");
		expect(container.textContent?.match(/图片未发送/g)).toHaveLength(1);
	});

	it("shows unpublished and invalid references as not sent without any request, and never loads other image URLs (AC-2)", () => {
		const { value, readImage } = references();
		const { container } = render(
			<AssistantMarkdown references={value}>
				{
					"![缺失图](sandbox:missing.png) [缺失报告](sandbox:missing.pdf) ![越界](sandbox:../escape.png) [反斜杠](sandbox:a%5Cb.pdf) ![远程](https://tracker.example/a.png) ![相对](out/chart.png) [普通相对](out/chart.png) [](sandbox:empty.pdf)\n\n`![行内](sandbox:out/chart.png)`\n\n```\n![代码块](sandbox:out/chart.png)\n```"
				}
			</AssistantMarkdown>,
		);
		const text = container.textContent ?? "";
		expect(text).toContain("图片未发送：缺失图");
		expect(text).toContain("缺失报告（文件未发送）");
		expect(text).toContain("图片未发送：越界");
		expect(text).toContain("反斜杠（文件未发送）");
		expect(text).toContain("[图片：远程]");
		expect(text).toContain("[图片：相对]");
		expect(text).toContain("普通相对");
		expect(text).toContain("![行内](sandbox:out/chart.png)");
		expect(text).toContain("![代码块](sandbox:out/chart.png)");
		expect(container.querySelector("img, a, iframe")).toBeNull();
		expect(screen.queryByRole("group")).toBeNull();
		expect(readImage).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(URL.createObjectURL).not.toHaveBeenCalled();
	});

	it("says pending instead of not sent while the execution is still running", () => {
		const { value } = references({ settled: false }, []);
		const { container } = render(
			<AssistantMarkdown references={value}>
				{"![图](sandbox:out/chart.png) [报告](sandbox:r.pdf)"}
			</AssistantMarkdown>,
		);
		expect(container.textContent).toContain("图片待发送：图");
		expect(container.textContent).toContain("报告（文件待发送）");
		expect(container.textContent).not.toContain("未发送");
	});

	it("treats every sandbox reference as not sent when the answer has no result mapping", () => {
		const { container } = render(
			<AssistantMarkdown>{"![图](sandbox:out/chart.png)"}</AssistantMarkdown>,
		);
		expect(container.textContent).toContain("图片未发送：图");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("shows a denied or failed read exactly like an unsent image (AC-5)", async () => {
		const denied = references({ readImage: vi.fn(async () => null) });
		const failed = references({
			readImage: vi.fn(async () => {
				throw new Error("network");
			}),
		});
		const { container, rerender } = render(
			<AssistantMarkdown references={denied.value}>
				{"![图](sandbox:out/chart.png)"}
			</AssistantMarkdown>,
		);
		await waitFor(() => expect(container.textContent).toBe("图片未发送：图"));
		expect(container.querySelector("img")).toBeNull();
		rerender(
			<AssistantMarkdown references={failed.value}>
				{"![图](sandbox:out/chart.png)"}
			</AssistantMarkdown>,
		);
		await waitFor(() =>
			expect(failed.value.readImage).toHaveBeenCalledWith({
				fileId: "file-chart",
			}),
		);
		await waitFor(() => expect(container.textContent).toBe("图片未发送：图"));
		expect(container.querySelector("img")).toBeNull();
	});

	it("keeps an image inside a link visible but not a nested button", async () => {
		const { value } = references();
		render(
			<AssistantMarkdown references={value}>
				{"[![图](sandbox:out/chart.png)](https://example.com/docs)"}
			</AssistantMarkdown>,
		);
		const link = screen.getByRole("link");
		expect(link.getAttribute("href")).toBe("https://example.com/docs");
		expect(await within(link).findByRole("img", { name: "图" })).toBeTruthy();
		expect(within(link).queryByRole("button")).toBeNull();
	});

	it("registers files shown as images or cards, and releases images whose read fails", async () => {
		const registered = new Map<string, number>();
		const onRendered = vi.fn((fileId: string) => {
			registered.set(fileId, (registered.get(fileId) ?? 0) + 1);
			return () => registered.set(fileId, (registered.get(fileId) ?? 0) - 1);
		});
		const { value } = references({
			onRendered,
			readImage: vi.fn(async () => null),
		});
		const { container, unmount } = render(
			<AssistantMarkdown references={value}>
				{
					"![图](sandbox:out/chart.png) [报告](sandbox:r.pdf) [又是报告](sandbox:r.pdf) [缺失](sandbox:missing.pdf)"
				}
			</AssistantMarkdown>,
		);
		await waitFor(() => expect(container.textContent).toContain("图片未发送"));
		expect(Object.fromEntries(registered)).toEqual({
			"file-chart": 0,
			"file-report": 1,
		});
		unmount();
		expect(registered.get("file-report")).toBe(0);
	});

	it("exposes inline images and file cards to keyboard and screen readers (AC-4)", async () => {
		const { value } = references();
		render(
			<AssistantMarkdown references={value}>
				{"![](sandbox:out/chart.png)\n\n[r.pdf](sandbox:r.pdf)"}
			</AssistantMarkdown>,
		);
		// 没有说明文字时以文件名作为替代文本与按钮的对象名。
		const image = await screen.findByRole("img", { name: "chart.png" });
		const imageButton = screen.getByRole("button", {
			name: "预览图片：chart.png",
		});
		expect(imageButton.tagName).toBe("BUTTON");
		expect(imageButton.getAttribute("type")).toBe("button");
		expect(imageButton.contains(image)).toBe(true);
		const card = screen.getByRole("group", { name: "结果文件：r.pdf" });
		// 说明文字与文件名相同时不重复显示。
		expect(within(card).getAllByText("r.pdf")).toHaveLength(1);
		for (const control of [
			imageButton,
			within(card).getByRole("button", { name: "预览：r.pdf" }),
			within(card).getByRole("button", { name: "下载：r.pdf" }),
		]) {
			control.focus();
			expect(document.activeElement).toBe(control);
		}
	});

	it("bounds inline images and file cards inside the message width (AC-4)", () => {
		const css = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "../../index.css"),
			"utf8",
		);
		const rule = (selector: string) => {
			const start = css.indexOf(`${selector} {`);
			expect(start, selector).toBeGreaterThanOrEqual(0);
			return css.slice(start, css.indexOf("}", start));
		};
		expect(rule(".assistant-markdown .sandbox-image")).toContain(
			"max-width: min(100%, 480px)",
		);
		expect(rule(".assistant-markdown .sandbox-image-content")).toMatch(
			/max-width: 100%;[\s\S]*max-height: min\(320px, 50dvh\)/,
		);
		const card = rule(".assistant-markdown .sandbox-file-card");
		expect(card).toContain("max-width: 100%");
		expect(card).toContain("flex-wrap: wrap");
		expect(rule(".assistant-markdown .sandbox-file-card-body")).toContain(
			"min-width: 0",
		);
		expect(rule(".assistant-markdown .sandbox-file-card-name")).toContain(
			"text-overflow: ellipsis",
		);
	});
});

describe("result files of one execution", () => {
	it("keeps confirmed files of the execution once each and maps only V2 workspace references", () => {
		const v2 = (sequence: number, fileId: string, reference: string | null) =>
			PersistedConversationEventV2Schema.parse({
				...event(sequence),
				schemaVersion: 2,
				type: "result.file",
				payload: {
					fileId,
					name: `${fileId}.png`,
					mediaType: "image/png",
					sizeBytes: 3,
					workspaceReference: reference,
				},
			});
		const v1 = PersistedConversationEventV2Schema.parse({
			...event(4),
			type: "result.file",
			payload: {
				fileId: "legacy",
				name: "legacy.txt",
				mediaType: "text/plain",
				sizeBytes: 1,
			},
		});
		const other = { ...v2(5, "other", "a.png"), executionId: "execution-2" };
		const files = executionResultFiles(
			[
				v2(1, "first", "a.png"),
				v2(2, "first", "a.png"),
				v2(3, "image-block", null),
				v1,
				other,
				v2(6, "second", "a.png"),
			],
			"execution-1",
		);
		expect(files.map((file) => file.fileId)).toEqual([
			"first",
			"image-block",
			"legacy",
			"second",
		]);
		const index = sandboxReferenceIndex(files);
		expect([...index.keys()]).toEqual(["a.png"]);
		expect(index.get("a.png")?.fileId).toBe("first");
	});
});
