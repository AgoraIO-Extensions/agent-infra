import { execFileSync } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");
const script = join(root, "deploy/ack/redeploy.sh");

test("ACK re-deploy script is executable shell and exposes bounded commands", async () => {
	await access(script);
	execFileSync("bash", ["-n", script], { stdio: "pipe" });
	const help = execFileSync("bash", [script, "help"], { encoding: "utf8" });
	for (const command of [
		"plan",
		"deploy",
		"validate",
		"clean",
		"destroy",
		"all",
	])
		if (!help.includes(command)) throw new Error(`missing command: ${command}`);
});

test("ACK destructive command fails closed without its explicit confirmation", () => {
	let failed = false;
	try {
		execFileSync("bash", [script, "destroy"], {
			encoding: "utf8",
			stdio: "pipe",
		});
	} catch (error) {
		failed = true;
		const stderr = error.stderr?.toString() ?? "";
		if (!stderr.includes("ACK_CLEAN_CONFIRM=DELETE_ACK_ENV"))
			throw new Error("destroy did not explain its confirmation gate");
	}
	if (!failed) throw new Error("destroy unexpectedly succeeded");
});
