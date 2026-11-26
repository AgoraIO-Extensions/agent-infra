import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function renderAckChart(values?: unknown) {
	const directory = mkdtempSync(join(tmpdir(), "ack-chart-test-"));
	try {
		const args = [
			"template",
			"agent-infra",
			new URL("../../deploy/ack/chart", import.meta.url).pathname,
			"-n",
			"agent-infra",
			"--kube-version",
			"v1.36.1",
		];
		if (values) {
			const file = join(directory, "values.json");
			writeFileSync(file, JSON.stringify(values), { mode: 0o600 });
			args.push("-f", file);
		}
		return spawnSync("helm", args, { encoding: "utf8", timeout: 20_000 });
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
