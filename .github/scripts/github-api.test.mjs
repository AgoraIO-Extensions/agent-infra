import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  githubRequest,
  paginate,
  safeMarkdown,
  setOutput,
  writeOutputs,
} from "./github-api.mjs";

test("githubRequest sends fixed JSON headers and rejects non-JSON responses", async () => {
  const calls = [];
  const result = await githubRequest({
    apiUrl: "https://api.github.test/",
    token: "token",
    path: "/repos/example/project",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ id: 1 }), { status: 200 });
    },
  });

  assert.deepEqual(result.data, { id: 1 });
  assert.equal(calls[0].url, "https://api.github.test/repos/example/project");
  assert.equal(calls[0].options.headers.authorization, "Bearer token");

  await assert.rejects(
    githubRequest({
      apiUrl: "https://api.github.test",
      token: "token",
      path: "/invalid",
      fetchImpl: async () => new Response("not-json", { status: 200 }),
    }),
    /invalid JSON/,
  );
});

test("paginate follows pages and fails instead of truncating at its limit", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed.search);
    const page = Number(parsed.searchParams.get("page"));
    return new Response(
      JSON.stringify(page === 1 ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 100 }]),
      { status: 200 },
    );
  };

  await assert.rejects(
    paginate({
      apiUrl: "https://api.github.test",
      token: "token",
      path: "/items",
      maxItems: 100,
      fetchImpl,
    }),
    /exceeded the 100 item limit/,
  );
  assert.deepEqual(calls, ["?per_page=100&page=1", "?per_page=100&page=2"]);
});

test("writeOutputs rejects multiline values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-infra-output-"));
  const outputPath = join(directory, "output");
  try {
    await writeOutputs(outputPath, { eligible: true, reason: "eligible" });
    await setOutput(outputPath, "head_sha", "a".repeat(40));
    assert.equal(
      await readFile(outputPath, "utf8"),
      `eligible=true\nreason=eligible\nhead_sha=${"a".repeat(40)}\n`,
    );
    await assert.rejects(
      writeOutputs(outputPath, { unsafe: "one\ntwo" }),
      /single-line/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("safeMarkdown neutralizes controls, HTML, markers, and mentions", () => {
  assert.equal(
    safeMarkdown("<b>\\@team</b>\u0000 <!-- marker --> [x]! ```"),
    "&lt;b&gt;&#92;&#64;team&lt;/b&gt; &lt;&#33;-- marker --&gt; &#91;x&#93;&#33; &#96;&#96;&#96;",
  );
});
