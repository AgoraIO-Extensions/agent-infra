import manual from "../../../../../docs/guides/user-manual.md?raw";
import manualUrl from "../../../../../docs/guides/user-manual.md?url";

export { manualUrl };
export const guideChapters = manual
	.split(/^## /m)
	.slice(1)
	.map((text) => {
		const [heading, ...body] = text.split("\n");
		const match = /^(\d{2}) · (.+)$/.exec(heading);
		if (!match) throw new Error("Invalid user manual chapter heading");
		return { id: match[1], title: match[2], body: body.join("\n").trim() };
	});

export function guideChapter(id: unknown) {
	return guideChapters.find((chapter) => chapter.id === id) ?? guideChapters[0];
}

export function guideExcerpt(body: string, query: string) {
	const text = body
		.replace(/[#*|>`]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const match = text
		.toLocaleLowerCase()
		.indexOf(query.trim().toLocaleLowerCase());
	const start = Math.max(0, match - 40);
	return `${start > 0 ? "…" : ""}${text.slice(start, start + 150)}${text.length > start + 150 ? "…" : ""}`;
}
