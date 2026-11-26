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
import { parse } from "yaml";

function fixture(corrupt = false, unsigned = false, gitSigned = false) {
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
	let payload = `tree ${tree}\nauthor Fixture <fixture@example.test> 1 +0000\ncommitter Fixture <fixture@example.test> 1 +0000\n\nfixture\n`;
	const signature =
		"-----BEGIN PGP SIGNATURE-----\nfixture\n-----END PGP SIGNATURE-----\n";
	const raw = `tree ${tree}\nauthor Fixture <fixture@example.test> 1 +0000\ncommitter Fixture <fixture@example.test> 1 +0000\ngpgsig ${signature.replaceAll("\n", "\n ")}\n\nfixture\n`;
	let sha = git(["hash-object", "-t", "commit", "-w", "--stdin"], raw);
	if (gitSigned) {
		// Git constructs this commit. The signer is the only process seam; it records the payload
		// and returns a fixture signature, without a key or a second copy of header folding logic.
		const signer = join(root, "signer");
		const signedPayload = join(root, "signed-payload");
		writeFileSync(
			signer,
			`#!/usr/bin/env node
const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(signedPayload)},fs.readFileSync(0));
process.stdout.write(${JSON.stringify(signature)});process.stderr.write('[GNUPG:] SIG_CREATED D 1 8 00 1 fixture\\n');
`,
		);
		chmodSync(signer, 0o755);
		sha = git([
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.test",
			"-c",
			"user.signingkey=fixture",
			"-c",
			`gpg.program=${signer}`,
			"commit-tree",
			"-S",
			tree,
			"-m",
			"fixture",
		]);
		payload = readFileSync(signedPayload, "utf8");
	}
	const metadata = join(root, "commit.json");
	writeFileSync(
		metadata,
		JSON.stringify({
			sha,
			tree: { sha: tree },
			verification: { verified: !unsigned, payload, signature },
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
		`const source=process.argv.some(x=>x.includes('/git/commits/'))?${JSON.stringify(metadata)}:${JSON.stringify(archive)};require('node:fs').copyFileSync(source,process.argv[process.argv.indexOf('--output')+1]);`,
	);
	stub(
		"gh",
		`process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(metadata)}));`,
	);
	const output = join(root, "checkout");
	return {
		root,
		bin,
		source,
		stub,
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
test("a signed commit produced by Git restores its original SHA without an extra continuation line", (t) => {
	const f = fixture(false, false, true);
	t.after(f.close);
	const r = f.run();
	assert.equal(r.status, 0, r.stderr);
	assert.equal(
		execFileSync("git", ["-C", f.output, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim(),
		f.sha,
	);
});
test("unsigned source retries a transient Git fetch failure and checks the exact commit", (t) => {
	const f = fixture(false, true);
	t.after(f.close);
	const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	const attempts = join(f.root, "fetch-attempts");
	f.stub(
		"git",
		`
const fs=require('node:fs');const args=process.argv.slice(2);
if(args[0]==='fetch'){
 const count=fs.existsSync(${JSON.stringify(attempts)})?Number(fs.readFileSync(${JSON.stringify(attempts)},'utf8'))+1:1;
 fs.writeFileSync(${JSON.stringify(attempts)},String(count));
 if(count===1)process.exit(128);
 args[4]=${JSON.stringify(f.source)};
}
const result=require('node:child_process').spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(result.status??1);
`,
	);
	const r = f.run();
	assert.equal(r.status, 0, r.stderr);
	assert.equal(readFileSync(attempts, "utf8"), "2");
	assert.equal(
		execFileSync(realGit, ["-C", f.output, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim(),
		f.sha,
	);
});

for (const kind of ["deploy", "mirror"]) {
	for (const corrupt of [false, true]) {
		test(`${kind} bootstrap ${corrupt ? "rejects an archive for another tree" : "checks the downloaded archive against the exact SHA tree"}`, (t) => {
			const f = fixture(corrupt);
			t.after(f.close);
			mkdirSync(f.output);
			const workflow = parse(
				readFileSync(
					new URL(
						`../.github/workflows/${kind === "deploy" ? "deploy-production" : "mirror-images"}.yml`,
						import.meta.url,
					),
					"utf8",
				),
			);
			const bootstrap =
				workflow.jobs[kind === "deploy" ? "plan" : "mirror"].steps[0].run;
			assert.equal(
				typeof bootstrap,
				"string",
				"trusted archive bootstrap must run before repository code",
			);
			// Exercise the trusted inline shell before the runner-specific Node selection.
			const script = bootstrap
				.split("runner_node=")[0]
				.replaceAll("/home/runner/externals/node24/bin/node", process.execPath);
			const result = spawnSync("bash", ["-c", script], {
				encoding: "utf8",
				env: {
					...process.env,
					BASH_ENV: "/dev/null",
					PATH: `${f.bin}:${process.env.PATH}`,
					EXECUTOR_SOURCE_SHA: f.sha,
					RUNNER_TEMP: f.root,
					GITHUB_WORKSPACE: f.output,
				},
			});
			assert.equal(result.status === 0, !corrupt, result.stderr);
			if (corrupt)
				assert.match(result.stderr, /EXECUTOR_SOURCE_TREE_MISMATCH/u);
		});
	}
}
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
