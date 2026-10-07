// Copy this file beside the deployment-owned configuration.mjs.
// It reads primitive deployment inputs without putting secret values in argv,
// logs, or the configuration source itself. Factories and live authority
// functions still belong in configuration.mjs.

import { readFile } from "node:fs/promises";

export function requiredEnv(name) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`Missing deployment environment: ${name}`);
	return value;
}

export async function requiredFile(name) {
	const path = requiredEnv(name);
	if (!path.startsWith("/"))
		throw new Error(`${name} must be an absolute path`);
	const value = (await readFile(path, "utf8")).trim();
	if (!value) throw new Error(`Empty deployment file: ${name}`);
	return value;
}

export function booleanEnv(name, defaultValue = false) {
	const value = process.env[name];
	if (value === undefined) return defaultValue;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error(`${name} must be true or false`);
}

export function jsonEnv(name) {
	try {
		return JSON.parse(requiredEnv(name));
	} catch {
		throw new Error(`${name} must contain valid JSON`);
	}
}

export function runtimeImageBinding() {
	const repository = requiredEnv("AGENT_INFRA_RUNTIME_IMAGE_REPOSITORY");
	const digest = requiredEnv("AGENT_INFRA_RUNTIME_IMAGE_DIGEST");
	if (
		!/^[-a-z0-9./]+$/.test(repository) ||
		!/^sha256:[a-f0-9]{64}$/.test(digest)
	) {
		throw new Error(
			"Runtime image binding must use a repository and immutable digest",
		);
	}
	return { repository, digest };
}
