import { readFile, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const checkerCli = process.argv[2];
if (!checkerCli) throw new Error("Pass the installed markdown-link-check CLI path");
const check = createRequire(await realpath(checkerCli))("./index.js");
const config = JSON.parse(await readFile(".markdown-link-check.json", "utf8"));

async function markdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files.sort();
}

const files = ["README.md", "AGENTS.md", ...await markdownFiles(".github"), ...await markdownFiles("docs")];
let links = 0;
for (const file of files) {
  // 完整解码避免 CLI 在 64KiB Buffer 边界拆开中文字符（#3310）。
  const markdown = await readFile(file, "utf8");
  try {
    const results = await new Promise((accept, reject) => check(markdown, {
      ...config,
      baseUrl: pathToFileURL(dirname(resolve(file))).href,
      projectBaseUrl: pathToFileURL(process.cwd()).href,
    }, (error, results) => error ? reject(error) : accept(results)));
    links += results.length;
    const failures = results.filter(({ status }) => status === "dead" || status === "error");
    for (const failure of failures) console.error(`${file}: ${failure.status} ${failure.link}`);
    if (failures.length) process.exitCode = 1;
  } catch {
    console.error(`${file}: link checker failed`);
    process.exitCode = 1;
  }
}
console.log(`Checked ${files.length} Markdown files, ${links} links.`);
