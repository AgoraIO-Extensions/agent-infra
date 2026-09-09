import { spawnSync } from "node:child_process";

export function runCommand(command, args, options) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		env: options.env ?? process.env,
		killSignal: "SIGKILL",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: options.timeoutMs,
	});
	if (result.error?.code === "ETIMEDOUT") {
		throw new Error(`${options.name} timed out`);
	}
	if (result.error) throw new Error(`${options.name} could not start`);
	if (result.signal) {
		throw new Error(`${options.name} terminated by ${result.signal}`);
	}
	if (result.status !== 0) {
		options.onFailure?.(result.stderr);
		throw new Error(`${options.name} failed with exit status ${result.status}`);
	}
	return result.stdout.trim();
}
