import { describe, expect, it } from "vitest";
import {
	type SkillControlFileEntry,
	skillControlFileError,
	skillControlFileIds,
	skillControlFileSelectionError,
	skillControlFilesReady,
} from "./conversation-skill-control-file-model.js";

function textFile(name = "notes.txt", size = 5) {
	return new File(["x".repeat(size)], name, { type: "text/plain" });
}

function entry(
	localId: string,
	status: SkillControlFileEntry["status"],
	fileId?: string,
): SkillControlFileEntry {
	return { localId, file: textFile(), status, fileId };
}

describe("Skill control file limits", () => {
	it("accepts text/plain files at or under 4096 bytes", () => {
		expect(skillControlFileError(textFile("notes.txt", 4096))).toBeUndefined();
		expect(skillControlFileSelectionError(0, [textFile()])).toBeUndefined();
	});

	it("rejects non-text and oversized files before uploading", () => {
		expect(
			skillControlFileError(
				new File(["x"], "notes.pdf", { type: "application/pdf" }),
			),
		).toBe("仅支持 text/plain 文本文件。");
		expect(skillControlFileError(textFile("big.txt", 4097))).toBe(
			"单个控制文件不能超过 4096 字节。",
		);
	});

	it("rejects a selection that exceeds four files", () => {
		expect(
			skillControlFileSelectionError(0, [
				textFile("1.txt"),
				textFile("2.txt"),
				textFile("3.txt"),
				textFile("4.txt"),
				textFile("5.txt"),
			]),
		).toBe("最多只能附加 4 个控制文件。");
		expect(
			skillControlFileSelectionError(3, [textFile("4.txt"), textFile("5.txt")]),
		).toBe("最多只能附加 4 个控制文件。");
	});

	it("keeps the ordered file ids of uploaded files and blocks incomplete uploads", () => {
		const entries = [
			entry("local-1", "available", "file-1"),
			entry("local-2", "available", "file-2"),
		];
		expect(skillControlFileIds(entries)).toEqual(["file-1", "file-2"]);
		expect(skillControlFilesReady(entries)).toBe(true);
		expect(
			skillControlFileIds([...entries, entry("local-3", "uploading")]),
		).toEqual(["file-1", "file-2"]);
		expect(
			skillControlFilesReady([...entries, entry("local-3", "failed")]),
		).toBe(false);
	});
});
