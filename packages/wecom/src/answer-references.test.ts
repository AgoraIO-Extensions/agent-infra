import { expect, it } from "vitest";
import { parseWecomAnswerReferencesV1 } from "./answer-references.ts";

const spans = (markdown: string) =>
	parseWecomAnswerReferencesV1(markdown).map((reference) => ({
		text: markdown.slice(reference.start, reference.end),
		kind: reference.kind,
		workspaceReference: reference.workspaceReference,
		label: reference.label,
	}));

it("finds sandbox: links, images, reference links and their definitions in document order (#3229)", () => {
	const markdown = [
		"报告 [季度 **报告**](sandbox:out/report.pdf) 与 ![趋势](sandbox:/out/a%20b.png)。",
		"再看 [引用][r]、<sandbox:out/auto.txt> 和 [普通](out/plain.txt)。",
		"",
		"[r]: sandbox:./out/ref.csv",
		"[r]: sandbox:out/ignored.csv",
	].join("\n");
	expect(spans(markdown)).toEqual([
		{
			text: "[季度 **报告**](sandbox:out/report.pdf)",
			kind: "link",
			workspaceReference: "out/report.pdf",
			label: "季度 报告",
		},
		{
			text: "![趋势](sandbox:/out/a%20b.png)",
			kind: "image",
			workspaceReference: "out/a b.png",
			label: "趋势",
		},
		{
			text: "[引用][r]",
			kind: "link",
			workspaceReference: "out/ref.csv",
			label: "引用",
		},
		{
			text: "<sandbox:out/auto.txt>",
			kind: "link",
			workspaceReference: "out/auto.txt",
			label: "sandbox:out/auto.txt",
		},
		{
			text: "[r]: sandbox:./out/ref.csv",
			kind: "definition",
			workspaceReference: "out/ref.csv",
			label: "",
		},
		{
			text: "[r]: sandbox:out/ignored.csv",
			kind: "definition",
			workspaceReference: "out/ignored.csv",
			label: "",
		},
	]);
});

it("skips code, raw HTML and bare paths, and marks invalid references (#3229)", () => {
	const markdown = [
		"```",
		"[代码块](sandbox:out/a.txt)",
		"```",
		'行内 `[代码](sandbox:out/b.txt)`、<a href="sandbox:out/c.txt">HTML</a>、sandbox:out/d.txt。',
		"[越界](sandbox:../secret) [反斜杠](sandbox:out%5Cx) [空](sandbox:)",
	].join("\n");
	expect(spans(markdown)).toEqual([
		{
			text: "[越界](sandbox:../secret)",
			kind: "link",
			workspaceReference: null,
			label: "越界",
		},
		{
			text: "[反斜杠](sandbox:out%5Cx)",
			kind: "link",
			workspaceReference: null,
			label: "反斜杠",
		},
		{
			text: "[空](sandbox:)",
			kind: "link",
			workspaceReference: null,
			label: "空",
		},
	]);
});

it("reports a nested image inside a link after its outer link (#3229)", () => {
	expect(spans("[![图](sandbox:i.png)](sandbox:out/a.pdf)")).toEqual([
		{
			text: "[![图](sandbox:i.png)](sandbox:out/a.pdf)",
			kind: "link",
			workspaceReference: "out/a.pdf",
			label: "图",
		},
		{
			text: "![图](sandbox:i.png)",
			kind: "image",
			workspaceReference: "i.png",
			label: "图",
		},
	]);
	expect(parseWecomAnswerReferencesV1("")).toEqual([]);
});

it("keeps offsets on the original answer when it starts with a BOM (#3229)", () => {
	expect(spans("\uFEFF[a](sandbox:x.png) tail")).toEqual([
		{
			text: "[a](sandbox:x.png)",
			kind: "link",
			workspaceReference: "x.png",
			label: "a",
		},
	]);
});
