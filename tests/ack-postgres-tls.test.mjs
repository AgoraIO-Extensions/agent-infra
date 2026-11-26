import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function render(enabled) {
	return execFileSync(
		"helm",
		[
			"template",
			"postgres-test",
			new URL("../deploy/ack/chart", import.meta.url).pathname,
			"--kube-version",
			"v1.36.1",
			"--show-only",
			"templates/postgres.yaml",
			"--set",
			"postgres.enabled=true",
			"--set",
			"postgres.dashboardTlsKeyOnVolume=" + enabled,
		],
		{ encoding: "utf8" },
	);
}

test("PostgreSQL restores its TLS key mode after fsGroup changes permissions at mount", () => {
	const manifest = render(true);
	const init = manifest.slice(
		manifest.indexOf("initContainers:"),
		manifest.indexOf("\n      containers:"),
	);
	const command = init.match(/args:\n *- \|\n((?:[ ]{14}[^\n]*\n)+)/u)?.[1];
	assert.ok(command, "read the init container command from the rendered chart");
	assert.match(
		init,
		/name: PGDATA, value: "\/var\/lib\/postgresql\/data\/pgdata"/u,
	);
	const data = mkdtempSync(join(tmpdir(), "postgres-key-mode-"));
	try {
		const run = () =>
			execFileSync("/bin/sh", ["-ec", command], {
				env: { ...process.env, PGDATA: data },
			});
		run();
		mkdirSync(join(data, "dashboard-tls"));
		const file = join(data, "dashboard-tls", "server.key");
		writeFileSync(file, "fixture");
		chmodSync(file, 0o660);
		run();
		assert.equal(statSync(file).mode & 0o777, 0o600);
	} finally {
		rmSync(data, { recursive: true, force: true });
	}
	assert.doesNotMatch(render(false), /name: dashboard-tls-key-mode/u);
});
