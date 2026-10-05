import { expect, it } from "vitest";
import { loadDirectorySource } from "./source.js";

it("loads only a trusted deployment file and preserves its independent source", async () => {
	const source = {
		fetchComplete: async () => ({ departments: [], members: [] }),
	};
	const loaded = await loadDirectorySource(
		{ DIRECTORY_SOURCE_MODULE: "file:///deployment/source.mjs" },
		1,
		async (url) => {
			expect(url).toBe("file:///deployment/source.mjs");
			return { sourceId: "enterprise-tools", source };
		},
	);
	expect(loaded).toEqual({ sourceId: "enterprise-tools", source });
});
it("rejects remote modules and invalid exports without leaking module errors", async () => {
	for (const url of [
		"https://source.test/source.mjs",
		"file://remote/source.mjs",
		"file:///source.mjs?secret=value",
	]) {
		await expect(
			loadDirectorySource({ DIRECTORY_SOURCE_MODULE: url }, 1, async () => {
				throw new Error("must not load");
			}),
		).rejects.toThrow("DIRECTORY_SOURCE_MODULE_INVALID");
	}
	for (const module of [
		{ sourceId: "", source: {} },
		{ sourceId: "source", source: {} },
		{
			sourceId: "https://source.test",
			source: { fetchComplete: async () => ({}) },
		},
	]) {
		await expect(
			loadDirectorySource(
				{ DIRECTORY_SOURCE_MODULE: "file:///source.mjs" },
				1,
				async () => module,
			),
		).rejects.toThrow("DIRECTORY_SOURCE_MODULE_INVALID");
	}
	await expect(
		loadDirectorySource(
			{ DIRECTORY_SOURCE_MODULE: "file:///source.mjs" },
			1,
			async () => {
				throw new Error("private credential detail");
			},
		),
	).rejects.toThrow(/^DIRECTORY_SOURCE_MODULE_INVALID$/);
});
