import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bundleInventory } from "../../packages/config/bundle-inventory.ts";

test("actual chunk inputs include nested package metadata without publishing machine paths", () => {
  const root = mkdtempSync(join(tmpdir(), "connection-bundle-test-"));
  try {
    mkdirSync(join(root, "node_modules", "pkg", "lib"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "workspace" }));
    writeFileSync(join(root, "node_modules", "pkg", "package.json"), JSON.stringify({ name: "pkg", version: "1.2.3", license: "MIT" }));
    writeFileSync(join(root, "node_modules", "pkg", "lib", "package.json"), JSON.stringify({ type: "module" }));
    const file = join(root, "node_modules", "pkg", "lib", "index.js"); writeFileSync(file, "export const value=1;");
    const plugin = bundleInventory("connection-api", root);
    plugin.generateBundle({}, { "index.js": { type: "chunk", modules: { [file]: {}, "\0compiler-runtime": {} } } });
    const raw = readFileSync(join(root, "build-evidence", "connection-api", "bundle-inventory.json"), "utf8");
    const inventory = JSON.parse(raw);
    assert.equal(inventory.components[0].name, "pkg");
    assert.equal(inventory.components[0].version, "1.2.3");
    assert.equal(inventory.components[0].inputs[0].path, "node_modules/pkg/lib/index.js");
    assert.equal(inventory.generatedModules, 1);
    assert.equal(raw.includes(root), false);
    assert.throws(() => plugin.generateBundle({}, {}));
    assert.throws(() => plugin.generateBundle({}, { "index.js": { type: "chunk", modules: { "unknown-generated-module": {} } } }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
