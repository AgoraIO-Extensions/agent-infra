import { readFile, writeFile } from "node:fs/promises";
import { guideMarkdown } from "../src/features/user-guide/content.ts";

const file = new URL(
	"../../../docs/guides/connection-user-manual.md",
	import.meta.url,
);
const content = guideMarkdown();
if (process.argv.includes("--write")) await writeFile(file, content);
else if ((await readFile(file, "utf8")) !== content)
	throw new Error("Connection manual is stale. Run guide:generate.");
