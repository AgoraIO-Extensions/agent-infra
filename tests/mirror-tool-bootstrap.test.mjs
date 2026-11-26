import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const hashes = {
	crane: "0ab7a1d6932a213aed964ce97666c3077fe691c8606413674a8b3e0b9ec4cda0",
	gh: "79e7ab5db738c48777b696e374f8b428f0647debfb424f44d2f426370407fe2f",
};

function fixture({ badHash = false, downloadFails = false } = {}) {
	const root = mkdtempSync(join(tmpdir(), "mirror-tools-"));
	const bin = join(root, "bin");
	mkdirSync(bin);
	const paths = { crane: "crane", gh: "gh_2.105.0_linux_amd64/bin/gh" };
	for (const [name, file] of Object.entries(paths)) {
		mkdirSync(join(root, "payload", file, ".."), { recursive: true });
		writeFileSync(join(root, "payload", file), "#!/bin/sh\nexit 0\n");
		chmodSync(join(root, "payload", file), 0o755);
		execFileSync("tar", ["-czf", join(root, `${name}.tgz`), file], {
			cwd: join(root, "payload"),
		});
	}
	const stub = (name, body) => {
		writeFileSync(join(bin, name), `#!/usr/bin/env node\n${body}`);
		chmodSync(join(bin, name), 0o755);
	};
	stub(
		"curl",
		`
const fs=require('node:fs');const a=process.argv.slice(2);
const url=a.find(x=>x.startsWith('https://'));
const name=url==='https://api.github.com/repos/cli/cli/releases/assets/761188566'?'gh':url==='https://api.github.com/repos/google/go-containerregistry/releases/assets/543544389'?'crane':undefined;
if(!name)process.exit(9);
const option = (key) => a.includes(key) ? a[a.indexOf(key) + 1] : undefined;
for (const [key, value] of [['--connect-timeout','10'], ['--speed-limit','102400'], ['--speed-time','20'], ['--retry','3']]) {
  if (option(key) !== value) process.exit(10);
}
if (!a.includes('--retry-all-errors')) process.exit(10);
// The pinned release assets must fit at the configured low-speed threshold.
const bytes = name === 'crane' ? 16_496_784 : 15_050_573;
const transferSeconds = Math.ceil(bytes / Number(option('--speed-limit')));
const deadline = Number(option('--max-time'));
if (deadline !== 240 || deadline < Number(option('--connect-timeout')) + transferSeconds) process.exit(28);
if(${downloadFails})process.exit(28);
fs.copyFileSync(${JSON.stringify(root)}+'/'+name+'.tgz',a[a.indexOf('--output')+1]);
`,
	);
	// The process boundary supplies the checksum result; production still uses coreutils.
	stub(
		"sha256sum",
		`const f=process.argv.at(-1);const hashes=${JSON.stringify(hashes)};process.stdout.write((${badHash}?'0'.repeat(64):hashes[f.endsWith('/gh.tgz')?'gh':'crane'])+'  '+f+'\\n');`,
	);
	const output = join(root, "github-path");
	return {
		root,
		output,
		run: () =>
			spawnSync(
				"bash",
				[
					new URL("../.github/scripts/install-mirror-tools.sh", import.meta.url)
						.pathname,
				],
				{
					encoding: "utf8",
					timeout: 10_000,
					env: {
						...process.env,
						BASH_ENV: "/dev/null",
						PATH: `${bin}:${process.env.PATH}`,
						RUNNER_TEMP: root,
						GITHUB_PATH: output,
					},
				},
			),
		close: () => rmSync(root, { recursive: true, force: true }),
	};
}

test("mirror tools install pinned assets before publishing their executable path", (t) => {
	const f = fixture();
	t.after(f.close);
	const result = f.run();
	assert.equal(result.status, 0, result.stderr);
	assert.equal(
		readFileSync(f.output, "utf8").trim(),
		join(f.root, "mirror-tools/bin"),
	);
	for (const name of ["crane", "gh"]) {
		assert.equal(spawnSync(join(f.root, "mirror-tools/bin", name)).status, 0);
	}
});

test("a wrong tool checksum fails before making any downloaded tool available", (t) => {
	const f = fixture({ badHash: true });
	t.after(f.close);
	const result = f.run();
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /MIRROR_TOOL_CHECKSUM_MISMATCH/u);
	assert.equal(existsSync(f.output), false);
});

test("an exhausted download returns a named error and publishes no executable path", (t) => {
	const f = fixture({ downloadFails: true });
	t.after(f.close);
	const result = f.run();
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /MIRROR_TOOL_DOWNLOAD_FAILED/u);
	assert.equal(existsSync(f.output), false);
});
