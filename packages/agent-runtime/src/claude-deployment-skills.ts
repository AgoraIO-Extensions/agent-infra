import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const claudeDeploymentPluginName = "agent-deployment";

/** A JSON string is also a quoted YAML scalar. Keep SDK substitutions and
 * Markdown expressions out of the generated Skill source. */
function literal(value: string) {
	const escaped = value.replace(
		/[^a-zA-Z0-9./_-]/g,
		(character) =>
			`\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
	return `"${escaped}"`;
}

/** This per-Query plugin lives outside workspace and memory. Its only files
 * are Host-authored navigation. The published body still needs a signed Read. */
export async function createClaudeDeploymentPlugin(sessionTmp: string) {
	const path = await mkdtemp(join(sessionTmp, "deployment-skills-"));
	const metadata = join(path, ".claude-plugin");
	const skills = join(path, "skills");
	const directories = [path];
	const close = async () => {
		// Restore only Host-created directories so the non-root Host can remove them.
		for (const directory of directories) await chmod(directory, 0o700);
		await rm(path, { recursive: true, force: true });
	};
	try {
		await mkdir(metadata, { mode: 0o700 });
		directories.push(metadata);
		await mkdir(skills, { mode: 0o700 });
		directories.push(skills);
		await writeFile(
			join(metadata, "plugin.json"),
			JSON.stringify({ name: claudeDeploymentPluginName, version: "1.0.0" }),
			{ mode: 0o400, flag: "wx" },
		);
		await chmod(metadata, 0o500);
		await chmod(path, 0o500);
	} catch (error) {
		await close();
		throw error;
	}
	return {
		path,
		close,
		async register(
			entries: readonly { name: string; description: string; path: string }[],
		) {
			for (const entry of entries) {
				const folder = join(skills, entry.name);
				await mkdir(folder, { mode: 0o700 });
				directories.push(folder);
				const source = [
					"---",
					`name: ${literal(entry.name)}`,
					`description: ${literal(entry.description)}`,
					"user-invocable: false",
					"---",
					"Read the published Skill instructions using the Read tool with this JSON input:",
					`{"file_path":${literal(entry.path)}}`,
					"",
				].join("\n");
				await writeFile(join(folder, "SKILL.md"), source, {
					mode: 0o400,
					flag: "wx",
				});
				await chmod(folder, 0o500);
			}
			await chmod(skills, 0o500);
		},
	};
}
