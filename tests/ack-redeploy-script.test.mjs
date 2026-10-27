import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");
const script = join(root, "deploy/ack/redeploy.sh");

test("ACK re-deploy script is executable shell and exposes bounded commands", async () => {
	await access(script);
	execFileSync("bash", ["-n", script], { stdio: "pipe" });
	const help = execFileSync("bash", [script, "help"], { encoding: "utf8" });
	for (const command of [
		"capture-inputs",
		"plan",
		"bootstrap-plan",
		"bootstrap-inputs",
		"bootstrap-database",
		"bootstrap-credential",
		"cleanup-plan",
		"deploy",
		"provision",
		"validate",
		"clean",
		"destroy",
		"all",
	])
		if (!help.includes(command)) throw new Error(`missing command: ${command}`);
	if (
		!help.includes("ACK_RUNTIME_IMAGE_MANIFEST") ||
		!help.includes("ACK_CA_CERT_FILE")
	)
		throw new Error("provenance and CA inputs are missing from help");
	if ((await readFile(script, "utf8")).includes("--insecure"))
		throw new Error(
			"HTTPS validation must not disable certificate verification",
		);
	const source = await readFile(script, "utf8");
	if (!source.includes('git -C "$repo_root" status --porcelain --untracked-files=all'))
		throw new Error("deploy must reject a dirty source checkout");
	const allBlock = source.slice(source.indexOf("\n\tall)"));
	if (
		allBlock.indexOf("bootstrap_credential") >
		allBlock.indexOf('agent-bindings.ts" check')
	)
		throw new Error(
			"all must issue the credential before validating Agent inputs",
		);
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

test("cleanup cannot mutate ACK even when legacy destruction flags are set", () => {
	for (const command of ["clean", "destroy"]) {
		let failed = false;
		try {
			execFileSync("bash", [script, command], {
				env: {
					...process.env,
					ACK_CLEAN_CONFIRM: "DELETE_ACK_ENV",
					ACK_CLEAN_DELETE_DATA: "true",
					ACK_CLEAN_DELETE_NAMESPACE: "true",
				},
				stdio: "pipe",
			});
		} catch (error) {
			failed = true;
			if (!error.stderr.toString().includes("cleanup is disabled"))
				throw new Error("cleanup did not stop at the inventory gate");
		}
		if (!failed) throw new Error("cleanup unexpectedly succeeded");
	}
});
