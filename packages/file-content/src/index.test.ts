import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createContentProbe, inspectFileContentV1 } from "./index.ts";

// 最小的 1×1 PNG 与 PDF 头；识别只依赖文件头魔数。
const png = Buffer.from(
	"89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
		"1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
	"hex",
);
const pdf = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n");

describe("file content facts (#3226)", () => {
	it("identifies media types from the actual bytes", async () => {
		await expect(inspectFileContentV1(png, 1024)).resolves.toEqual({
			sizeBytes: png.byteLength,
			mediaType: "image/png",
			sha256: createHash("sha256").update(png).digest("hex"),
		});
		await expect(inspectFileContentV1(pdf, 1024)).resolves.toMatchObject({
			mediaType: "application/pdf",
		});
		await expect(
			inspectFileContentV1(Buffer.from("plain text\n"), 1024),
		).resolves.toMatchObject({ mediaType: "text/plain" });
	});

	it("rejects unverifiable formats and content over the limit", async () => {
		await expect(
			inspectFileContentV1(Buffer.from([0, 1, 2, 3, 255, 254]), 1024),
		).rejects.toThrow("File format cannot be verified");
		await expect(inspectFileContentV1(png, png.byteLength - 1)).rejects.toThrow(
			"File content limit exceeded",
		);
	});

	it("gives the streaming probe and the in-memory helper the same answer", async () => {
		const probe = createContentProbe(1024);
		probe.write(pdf.subarray(0, 5));
		probe.write(pdf.subarray(5));
		await expect(probe.finish()).resolves.toEqual(
			await inspectFileContentV1(pdf, 1024),
		);
	});
});
