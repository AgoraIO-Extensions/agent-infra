import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("starts a full idle interval after a brief reconnect between polls", async () => {
	const directory = await mkdtemp(join(tmpdir(), "maintenance-idle-"));
	const observations = join(directory, "observations");
	try {
		await writeFile(observations, "");
		await writeFile(
			join(directory, "tmux"),
			`#!/bin/sh
echo poll >> "$OBSERVATIONS"
case "$(wc -l < "$OBSERVATIONS" | tr -d ' ')" in
  1) echo "1 42:0" ;;
  2) echo "0 42:1" ;;
  *) echo "0 42:2" ;;
esac
`,
			{ mode: 0o755 },
		);
		await promisify(execFile)(
			process.execPath,
			[fileURLToPath(new URL("./maintenance-idle.ts", import.meta.url)), "100"],
			{
				env: {
					...process.env,
					PATH: directory + ":" + process.env.PATH,
					OBSERVATIONS: observations,
				},
				timeout: 8_000,
			},
		);
		expect(
			(await readFile(observations, "utf8")).trim().split("\n"),
		).toHaveLength(4);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 12_000);
