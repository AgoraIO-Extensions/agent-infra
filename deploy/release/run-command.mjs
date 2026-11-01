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
	const failureDetail = [result.stderr, result.error?.code, result.signal]
		.filter(Boolean)
		.join(" ");
	if (result.error?.code === "ETIMEDOUT") {
		options.onFailure?.(failureDetail);
		throw new Error(`${options.name} timed out`);
	}
	if (result.error) {
		options.onFailure?.(failureDetail);
		throw new Error(`${options.name} could not start`);
	}
	if (result.signal) {
		options.onFailure?.(failureDetail);
		throw new Error(`${options.name} terminated by ${result.signal}`);
	}
	if (result.status !== 0) {
		options.onFailure?.(failureDetail);
		throw new Error(`${options.name} failed with exit status ${result.status}`);
	}
	return options.trimOutput === false ? result.stdout : result.stdout.trim();
}
