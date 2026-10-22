import { expect, it } from "vitest";
import {
	orderWecomResultFilesV1,
	rewriteWecomAnswerV1,
	wecomOutboundMediaKindV1,
} from "./wecom-reply-media.ts";

const mebibyte = 1024 * 1024;
it.each([
	["image/png", 4, null],
	["image/png", 5, "image"],
	["image/jpeg", 10 * mebibyte, "image"],
	["image/gif", 10 * mebibyte + 1, "file"],
	["image/webp", 1024, "file"],
	["video/mp4", 10 * mebibyte, "video"],
	["video/mp4", 10 * mebibyte + 1, "file"],
	["video/quicktime", 1024, "file"],
	["application/pdf", 20 * mebibyte, "file"],
	["application/pdf", 20 * mebibyte + 1, null],
	["application/pdf", Number.NaN, null],
] as const)(
	"maps %s of %d bytes to %s by the official WeCom limits (#3229)",
	(mediaType, sizeBytes, kind) => {
		expect(wecomOutboundMediaKindV1({ mediaType, sizeBytes })).toBe(kind);
	},
);

const file = (fileId: string, workspaceReference: string | null) => ({
	fileId,
	name: `${fileId}.pdf`,
	mediaType: "application/pdf",
	sizeBytes: 10,
	workspaceReference,
});
it("orders referenced files by first appearance and keeps the rest in event order (#3229)", () => {
	const files = [
		file("c", null),
		file("b", "b"),
		file("x", "x"),
		file("a", "a"),
	];
	const references = [
		{ start: 0, end: 1, kind: "link", workspaceReference: "a", label: "" },
		{
			start: 2,
			end: 3,
			kind: "definition",
			workspaceReference: "x",
			label: "",
		},
		{ start: 4, end: 5, kind: "image", workspaceReference: "b", label: "" },
		{ start: 6, end: 7, kind: "link", workspaceReference: "a", label: "" },
	] as const;
	expect(
		orderWecomResultFilesV1(files, references).map((entry) => entry.fileId),
	).toEqual(["a", "b", "c", "x"]);
});
it("rewrites the outermost span of a nested reference and drops CRLF definitions (#3229)", () => {
	const answer = "[![i](sandbox:i.png)](sandbox:a)\r\n[d]: sandbox:a\r\nend";
	const text = rewriteWecomAnswerV1({
		answer,
		references: [
			{ start: 0, end: 32, kind: "link", workspaceReference: "a", label: "" },
			{
				start: 1,
				end: 20,
				kind: "image",
				workspaceReference: "i.png",
				label: "i",
			},
			{
				start: 34,
				end: 48,
				kind: "definition",
				workspaceReference: "a",
				label: "",
			},
		],
		files: [file("a", "a"), file("i", "i.png")],
		skipped: new Map([["i", "unsupported_channel"]]),
	});
	expect(text).toBe(
		"a.pdf（见下方文件）\r\nend\n\ni.pdf（当前渠道不支持发送文件）",
	);
	expect(text).not.toContain("sandbox:");
});
