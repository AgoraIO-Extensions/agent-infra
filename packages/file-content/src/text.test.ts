import { describe, expect, it } from "vitest";
import { createContentProbe, inspectFileContentV1 } from "./index.ts";
import {
	isTextContentV1,
	requiresTextContentV1,
	resolveFileMediaTypeV1,
	TEXT_SUBTYPE_DECLARATIONS_V1,
} from "./text.ts";

const png = Buffer.from(
	"89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
		"1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
	"hex",
);
const csv = Buffer.from("名称,数量\n苹果,3\n");
// GBK 编码的“名称”：不是合法 UTF-8。
const gbk = Buffer.from("c3fbb3c62c310a", "hex");

async function probe(bytes: Uint8Array, declared?: string) {
	const content = createContentProbe(1024, declared);
	content.write(bytes);
	return content.finish();
}

describe("text subtype declarations (#3257)", () => {
	it("keeps the platform whitelist fixed and frozen", () => {
		expect([...TEXT_SUBTYPE_DECLARATIONS_V1]).toEqual([
			"application/json",
			"text/csv",
			"text/markdown",
			"text/tab-separated-values",
		]);
		expect(Object.isFrozen(TEXT_SUBTYPE_DECLARATIONS_V1)).toBe(true);
		expect(() =>
			(TEXT_SUBTYPE_DECLARATIONS_V1 as string[]).push("text/x-python"),
		).toThrow();
	});

	it("adopts a whitelisted declaration only when the bytes are plain text", () => {
		for (const declared of TEXT_SUBTYPE_DECLARATIONS_V1)
			expect(resolveFileMediaTypeV1("text/plain", declared)).toBe(declared);
		expect(resolveFileMediaTypeV1("text/plain")).toBe("text/plain");
		expect(resolveFileMediaTypeV1("text/plain", "text/plain")).toBe(
			"text/plain",
		);
		expect(resolveFileMediaTypeV1("text/plain", "text/x-python")).toBe(
			"text/plain",
		);
		expect(resolveFileMediaTypeV1("text/plain", "text/html")).toBe(
			"text/plain",
		);
		expect(resolveFileMediaTypeV1("image/png", "text/csv")).toBe("image/png");
	});

	it("marks only text/plain and whitelisted declarations as needing text content", () => {
		for (const declared of ["text/plain", ...TEXT_SUBTYPE_DECLARATIONS_V1])
			expect(requiresTextContentV1(declared)).toBe(true);
		for (const declared of ["image/png", "text/x-python", "text/calendar"])
			expect(requiresTextContentV1(declared)).toBe(false);
	});

	it("judges text as valid UTF-8 without control characters", () => {
		expect(isTextContentV1(csv)).toBe(true);
		expect(isTextContentV1(new Uint8Array())).toBe(true);
		expect(isTextContentV1(Buffer.from("a\tb\r\nc"))).toBe(true);
		expect(isTextContentV1(gbk)).toBe(false);
		expect(isTextContentV1(Buffer.from("a\0b"))).toBe(false);
		expect(isTextContentV1(Buffer.from("a\x7fb"))).toBe(false);
		expect(isTextContentV1(png)).toBe(false);
		// 末尾被截断的多字节序列同样不是合法 UTF-8。
		expect(isTextContentV1(Buffer.from([0x61, 0xe4, 0xb8]))).toBe(false);
	});
});

describe("content probe normalization (#3257)", () => {
	it("records a whitelisted text declaration and keeps byte detection without one", async () => {
		await expect(probe(csv, "text/csv")).resolves.toMatchObject({
			mediaType: "text/csv",
		});
		await expect(
			probe(Buffer.from("# 标题\n"), "text/markdown"),
		).resolves.toMatchObject({ mediaType: "text/markdown" });
		await expect(
			probe(Buffer.from('{"a":1}'), "application/json"),
		).resolves.toMatchObject({ mediaType: "application/json" });
		await expect(probe(csv)).resolves.toMatchObject({
			mediaType: "text/plain",
		});
		await expect(inspectFileContentV1(csv, 1024)).resolves.toMatchObject({
			mediaType: "text/plain",
		});
	});

	it("falls back to byte detection for declarations the bytes cannot confirm", async () => {
		// 白名单之外的子类型：结果仍是 text/plain，调用方核对声明不一致即拒绝。
		await expect(probe(csv, "text/x-python")).resolves.toMatchObject({
			mediaType: "text/plain",
		});
		// 声明 text/csv、实际是 PNG：结果是 image/png。
		await expect(probe(png, "text/csv")).resolves.toMatchObject({
			mediaType: "image/png",
		});
		// 声明 text/csv、内容不是合法 UTF-8：无法确认格式。
		await expect(probe(gbk, "text/csv")).rejects.toThrow(
			"File format cannot be verified",
		);
	});

	it("does not apply text declarations to skill package evidence", async () => {
		const content = createContentProbe(1024, "text/csv", "skill-package");
		content.write(csv);
		await expect(content.finish()).rejects.toThrow(
			"Unsupported skill package media type",
		);
	});
});
