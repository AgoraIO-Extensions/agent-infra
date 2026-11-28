import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeExternalActionAuthorizer } from "./driver.js";
import { deploymentInstructions } from "./paseo-pod.js";
import {
	openPiDeploymentSkills,
	piDeploymentFiles,
} from "./pi-deployment-skills.js";
import { publishedDeploymentReadActions } from "./published-deployment-skills.js";
import type { NativeSessionOptions } from "./session-runtime-driver.js";
import type { RuntimeFilesystemSkillDirectoryV1 } from "./skill-hub-directory.js";

/** The only additional inputs for the native RPC process are Worker-published ordinary Markdown. */
export async function openPiNativeProject(
	scope: string,
	session: () => Pick<
		NativeSessionOptions,
		| "connectionReference"
		| "runtimeSessionRef"
		| "executionId"
		| "ordinaryTurn"
		| "recordOperationFact"
	>,
	hub?: RuntimeFilesystemSkillDirectoryV1,
	authorize?: RuntimeExternalActionAuthorizer,
	root = piDeploymentFiles,
) {
	const execution = session().connectionReference;
	if (!execution) return;
	const directory = await openPiDeploymentSkills({
		scope,
		execution,
		hub,
		projected: true,
		root,
	});
	const instructions = await deploymentInstructions(root);
	const entries = directory.entries;
	const conflicts = new Set(directory.conflictingNames);
	const excludedHubPaths = new Set(
		hub
			?.findSkills()
			.filter((entry) => conflicts.has(entry.name) && hub.nativeRoot)
			.map((entry) => join(hub.nativeRoot ?? "", entry.targetPath, "SKILL.md")),
	);

	if (entries.length && !authorize)
		throw new Error("RUNTIME_AUTHORIZATION_DENIED");
	const reads = authorize
		? publishedDeploymentReadActions(directory, session, authorize)
		: undefined;
	return {
		reads,
		entries,
		async confirmRead(
			message: string,
			pending: ReadonlyMap<string, string>,
			active: (id: string) => boolean,
		) {
			try {
				const selected: unknown = JSON.parse(message);
				if (!Array.isArray(selected) || selected.length !== 2) return false;
				const [id, path]: unknown[] = selected;
				if (
					typeof id !== "string" ||
					typeof path !== "string" ||
					pending.get(id) !== path ||
					!active(id)
				)
					return false;
				const grant = await reads?.allow(id, path, []);
				if (!grant || pending.get(id) !== path || !active(id)) return false;
				grant();
				return true;
			} catch {
				return false;
			}
		},
		async launchArgs(base: string[], configDirectory: string) {
			const args = base.filter(
				(value, index) =>
					!(
						(value === "--skill" &&
							excludedHubPaths.has(base[index + 1] ?? "")) ||
						(base[index - 1] === "--skill" && excludedHubPaths.has(value))
					),
			);
			if (instructions) args.push("--append-system-prompt", instructions);
			if (entries.length || conflicts.size) {
				// Use Pi's discovery metadata. Registering these files as slash commands would
				// let Pi expand their bodies before the original Execution's Read takes place.
				const { formatSkillsForPrompt } = await import(
					"@earendil-works/pi-coding-agent"
				);
				const sections = [
					formatSkillsForPrompt(directory.nativeSkills, "read"),
				];
				if (conflicts.size)
					sections.push(
						`Skill source conflicts: ${JSON.stringify([...conflicts])}. These Skills are unavailable by name. Report the source conflict when one is requested.`,
					);
				const metadata = join(configDirectory, "deployment-skills.md");
				await writeFile(metadata, sections.join("\n"), { mode: 0o600 });
				args.push("--append-system-prompt", metadata);
			}
			return args;
		},
		assertUnambiguous: directory.assertUnambiguous,
	};
}
export type PiNativeProject = NonNullable<
	Awaited<ReturnType<typeof openPiNativeProject>>
>;
