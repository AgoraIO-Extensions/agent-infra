import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./check-markdown-links.mjs", import.meta.url));

async function fixture(t, mode = "alive") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "markdown-links-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of [".github/nested", "docs/nested", "checker"]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  const heading = "# 对话结果文件预览\n";
  const linkPrefix = "[preview](#对";
  const text = heading + "a".repeat(65535 - Buffer.byteLength(heading + linkPrefix))
    + linkPrefix + "话结果文件预览)\n";
  const bytes = Buffer.from(text);
  assert.match(bytes.subarray(0, 65536).toString() + bytes.subarray(65536).toString(), /\uFFFD/);
  for (const file of ["README.md", "AGENTS.md", ".github/nested/check.md", "docs/nested/check.md"]) {
    await writeFile(join(root, file), text);
  }
  await writeFile(join(root, "docs/nested/ignored.txt"), "not Markdown");
  await writeFile(join(root, ".markdown-link-check.json"), JSON.stringify({ ignorePatterns: [{ pattern: "^https?://" }] }));
  const cli = join(root, "checker/markdown-link-check");
  await writeFile(cli, "");
  await writeFile(join(root, "checker/index.js"), `
const fs = require('node:fs');
module.exports = (markdown, options, callback) => {
  fs.appendFileSync('calls.jsonl', JSON.stringify({ markdown, options }) + '\\n');
  if (${JSON.stringify(mode)} === 'error') return callback(new Error('checker failure'));
  callback(null, [{ status: ${JSON.stringify(mode)}, link: '#对话结果文件预览' }]);
};
`);
  return { root, cli, text };
}

test("preserves UTF-8 across 64KiB and keeps every file's relative base/config", async (t) => {
  const { root, cli, text } = await fixture(t);
  const run = spawnSync(process.execPath, [script, cli], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Checked 4 Markdown files, 4 links/);
  const calls = (await readFile(join(root, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(({ options }) => fileURLToPath(options.baseUrl)), [
    root, root, join(root, ".github/nested"), join(root, "docs/nested"),
  ]);
  for (const call of calls) {
    assert.equal(call.markdown, text);
    assert.equal(fileURLToPath(call.options.projectBaseUrl), root);
    assert.deepEqual(call.options.ignorePatterns, [{ pattern: "^https?://" }]);
  }
});

for (const mode of ["dead", "error"]) {
  test(`fails closed on ${mode} results without dropping later files`, async (t) => {
    const { root, cli } = await fixture(t, mode);
    const run = spawnSync(process.execPath, [script, cli], { cwd: root, encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /README\.md:/);
    assert.match(run.stderr, /docs\/nested\/check\.md:/);
    assert.equal((await readFile(join(root, "calls.jsonl"), "utf8")).trim().split("\n").length, 4);
  });
}
