import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const unavailable = () => new Error("SNAPSHOT_BUSINESS_UNAVAILABLE");

export type SnapshotBusinessResult = {
	schemaVersion: 1;
	input: number;
	repoVersion: 1 | 2;
	dependencyVersion: string;
	total: number;
};

export function snapshotBusinessInput(value: string | null) {
	const text = value ?? "7";
	if (!/^(?:0|[1-9][0-9]{0,5}|1000000)$/u.test(text))
		throw new Error("SNAPSHOT_BUSINESS_INPUT_INVALID");
	return Number(text);
}

export function snapshotBusinessResult(
	value: unknown,
	input: number,
): SnapshotBusinessResult {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw unavailable();
	const result = value as Record<string, unknown>;
	if (
		Object.keys(result).toSorted().join(",") !==
			"dependencyVersion,input,repoVersion,schemaVersion,total" ||
		result.schemaVersion !== 1 ||
		result.input !== input ||
		(result.repoVersion !== 1 && result.repoVersion !== 2) ||
		typeof result.dependencyVersion !== "string" ||
		!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/u.test(result.dependencyVersion) ||
		!Number.isSafeInteger(result.total)
	)
		throw unavailable();
	return {
		schemaVersion: 1,
		input,
		repoVersion: result.repoVersion,
		dependencyVersion: result.dependencyVersion,
		total: result.total as number,
	};
}

/** The production caller fixes this root; HTTP clients cannot select executable paths. */
export async function runSnapshotBusiness(root: string, input: number) {
	try {
		if (snapshotBusinessInput(String(input)) !== input) throw unavailable();
		const { stdout, stderr } = await execute(
			process.execPath,
			[resolve(root, "repo/main.ts"), String(input)],
			{
				cwd: resolve(root, "repo"),
				encoding: "utf8",
				env: { NODE_NO_WARNINGS: "1" },
				timeout: 5000,
				killSignal: "SIGKILL",
				maxBuffer: 1024,
			},
		);
		if (stderr) throw unavailable();
		return snapshotBusinessResult(JSON.parse(stdout), input);
	} catch {
		// Child output and filesystem errors can contain snapshot bytes or paths.
		throw unavailable();
	}
}
