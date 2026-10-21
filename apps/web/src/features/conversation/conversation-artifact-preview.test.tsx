import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ArtifactPreviewDialog,
	artifactCanPreview,
	artifactPreviewKind,
	parseUnifiedDiff,
} from "./conversation-artifact-preview.js";
import { ConversationFilePicker } from "./conversation-files.js";

afterEach(cleanup);

const file = (
	overrides: Partial<{
		name: string;
		mediaType: string;
		sizeBytes: number;
	}> = {},
) => ({
	fileId: "result-1",
	name: "changes.diff",
	mediaType: "text/x-diff",
	sizeBytes: 42,
	executionId: "execution-1",
	...overrides,
});

describe("conversation artifact preview", () => {
	it("classifies safe preview formats and keeps unknown files downloadable", () => {
		expect(artifactPreviewKind(file())).toBe("diff");
		expect(
			artifactPreviewKind(file({ name: "photo.png", mediaType: "image/png" })),
		).toBe("image");
		expect(
			artifactPreviewKind(file({ name: "page.html", mediaType: "text/html" })),
		).toBe("html");
		expect(
			artifactPreviewKind(
				file({ name: "archive.zip", mediaType: "application/zip" }),
			),
		).toBe("none");
		expect(artifactCanPreview(file({ sizeBytes: 1024 * 1024 }))).toBe(true);
		expect(artifactCanPreview(file({ sizeBytes: 1024 * 1024 + 1 }))).toBe(
			false,
		);
	});

	it("parses unified diff rows and counts additions/deletions", () => {
		const result = parseUnifiedDiff(
			"diff --git a/readme.md b/readme.md\n@@ -1,2 +1,2 @@\n-old\n+new\n context",
		);
		expect(result.additions).toBe(1);
		expect(result.deletions).toBe(1);
		expect(result.rows.map((row) => row.kind)).toEqual([
			"file",
			"hunk",
			"del",
			"add",
			"context",
		]);
	});

	it("renders an isolated diff preview with a download action", async () => {
		render(
			<ArtifactPreviewDialog
				file={file()}
				content={new Blob(["@@ -1 +1 @@\n-old\n+new"], { type: "text/x-diff" })}
				open
				loading={false}
				onOpenChange={vi.fn()}
				onRetry={vi.fn()}
				onDownload={vi.fn()}
			/>,
		);
		await screen.findByTestId("artifact-diff-preview");
		expect(screen.getByText("+1 新增")).toBeTruthy();
		expect(screen.getByText("-1 删除")).toBeTruthy();
		expect(screen.getByRole("button", { name: "下载" })).toBeTruthy();
	});

	it("shows a local image thumbnail before upload completes", () => {
		const { container } = render(
			<ConversationFilePicker
				attachmentsEnabled
				limits={{
					schemaVersion: 1,
					revision: "files-v1",
					expiresAt: "2099-01-01T00:00:00Z",
					mediaTypes: ["image/png"],
					maxBytes: 1024 * 1024,
				}}
				limitsError={false}
				uploads={[
					{
						localId: "upload-1",
						file: new File(["png"], "screen.png", { type: "image/png" }),
						descriptor: null,
						projection: null,
						status: "uploading",
						previewUrl: "blob:local-image",
					},
				]}
				onSelect={vi.fn()}
				onRemove={vi.fn()}
				onRetry={vi.fn()}
			/>,
		);
		expect(container.querySelector("img")?.getAttribute("src")).toBe(
			"blob:local-image",
		);
		expect(screen.getByText("screen.png")).toBeTruthy();
	});
});
