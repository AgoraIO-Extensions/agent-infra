import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function fixture(corrupt = false) {
	const root = mkdtempSync(join(tmpdir(), "source-archive-"));
	const source = join(root, "source");
	mkdirSync(source);
	const bin = join(root, "bin");
	mkdirSync(bin);
	const git = (args, input) =>
		execFileSync("git", args, { cwd: source, input, encoding: "utf8" }).trim();
	git(["init", "--quiet"]);
	writeFileSync(join(source, "tracked.txt"), "expected source\n");
	git(["add", "tracked.txt"]);
	const tree = git(["write-tree"]);
	const payload = `tree ${tree}\nauthor Fixture <fixture@example.test> 1 +0000\ncommitter Fixture <fixture@example.test> 1 +0000\n\nfixture\n`;
	const signature =
		"-----BEGIN PGP SIGNATURE-----\nfixture\n-----END PGP SIGNATURE-----\n";
	const raw = `tree ${tree}\nauthor Fixture <fixture@example.test> 1 +0000\ncommitter Fixture <fixture@example.test> 1 +0000\ngpgsig ${signature.replaceAll("\n", "\n ")}\n\nfixture\n`;
	const sha = git(["hash-object", "-t", "commit", "-w", "--stdin"], raw);
	const metadata = join(root, "commit.json");
	writeFileSync(
		metadata,
		JSON.stringify({
			sha,
			tree: { sha: tree },
			verification: { verified: true, payload, signature },
		}),
	);
	git(["update-ref", "HEAD", sha]);
	const archive = join(root, "source.tar.gz");
	execFileSync(
		"git",
		["archive", "--format=tar.gz", "--prefix=archive/", "-o", archive, sha],
		{ cwd: source },
	);
	if (corrupt) {
		const folder = join(root, "archive");
		mkdirSync(folder);
		writeFileSync(join(folder, "tracked.txt"), "changed source\n");
		execFileSync("tar", ["-czf", archive, "archive"], { cwd: root });
	}
	const stub = (name, text) => {
		const file = join(bin, name);
		writeFileSync(file, "#!/usr/bin/env node\n" + text);
		chmodSync(file, 0o755);
	};
	stub(
		"curl",
		`require('node:fs').copyFileSync(${JSON.stringify(archive)},process.argv[process.argv.indexOf('--output')+1]);`,
	);
	stub(
		"gh",
		`process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(metadata)}));`,
	);
	const output = join(root, "checkout");
	return {
		output,
		sha,
		metadata,
		run: () =>
			spawnSync(
				process.execPath,
				[
					new URL("../deploy/ack/source-checkout.ts", import.meta.url).pathname,
					sha,
					output,
				],
				{
					encoding: "utf8",
					env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
				},
			),
		close: () => rmSync(root, { recursive: true, force: true }),
	};
}
test("official source archives restore the exact Git commit and a clean worktree", (t) => {
	const f = fixture();
	t.after(f.close);
	const r = f.run();
	assert.equal(r.status, 0, r.stderr);
	assert.equal(
		execFileSync("git", ["-C", f.output, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim(),
		f.sha,
	);
	assert.equal(
		execFileSync("git", ["-C", f.output, "status", "--porcelain"], {
			encoding: "utf8",
		}),
		"",
	);
	assert.equal(
		readFileSync(join(f.output, "tracked.txt"), "utf8"),
		"expected source\n",
	);
});
test("archive bytes that differ from the commit tree are rejected", (t) => {
	const f = fixture(true);
	t.after(f.close);
	const r = f.run();
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /SOURCE_ARCHIVE_TREE_MISMATCH/u);
});
test("metadata that is not the requested commit is rejected", (t) => {
	const f = fixture();
	t.after(f.close);
	const x = JSON.parse(readFileSync(f.metadata));
	x.sha = "0".repeat(40);
	writeFileSync(f.metadata, JSON.stringify(x));
	const r = f.run();
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /SOURCE_COMMIT_MISMATCH/u);
});
