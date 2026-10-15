import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MultiServiceManifestDocumentV1Schema } from "../packages/contracts/src/pilot/multi-service.ts";
import {
	packSkillProjectSnapshotV1,
	prepareSkillPackageV1,
} from "../packages/object-storage/src/skill-package-admission.ts";

const root = resolve("skills/agent-builder");
const read = (path: string) => readFile(resolve(root, path), "utf8");

function digestImage(value: string) {
	return /^sha256:[a-f0-9]{64}$/.test(value);
}

describe("agent-builder Skill source", () => {
	it("packs as an immutable Skill Hub project snapshot", async () => {
		const paths = [
			"SKILL.md",
			"README.md",
			"references/Dockerfile",
			"references/agent.yaml",
			"references/docker-compose.yml",
		];
		const files = await Promise.all(
			paths.map(async (path) => ({
				path,
				bytes: new Uint8Array(await readFile(resolve(root, path))),
			})),
		);
		const archive = packSkillProjectSnapshotV1(files);
		const prepared = prepareSkillPackageV1({
			archiveBytes: archive,
			name: "agent-builder",
			version: "0.1.0",
		});
		expect(prepared.manifest.entryPath).toBe("SKILL.md");
		expect(prepared.manifest.files.map((file) => file.path)).toEqual(
			paths.toSorted(),
		);
		expect(prepared.packageDigest).toMatch(/^[a-f0-9]{64}$/);
	});

	it("passes the offline multi-service output contract and documents hard stops", async () => {
		const skill = await read("SKILL.md");
		const compose = parse(await read("references/docker-compose.yml")) as {
			services: Record<string, unknown>;
		};
		const dockerfile = await read("references/Dockerfile");
		const manifest = MultiServiceManifestDocumentV1Schema.parse(
			parse(await read("references/agent.yaml")),
		);
		expect(Object.keys(compose.services)).toEqual(["web", "worker"]);
		expect(dockerfile).toContain("USER 10001:10001");
		expect(dockerfile).not.toContain("latest");
		expect(
			manifest.resources.filter((resource) => resource.kind === "Service"),
		).toHaveLength(2);
		for (const resource of manifest.resources) {
			if (resource.kind === "Deployment" || resource.kind === "StatefulSet")
				for (const container of resource.spec.template.spec.containers)
					expect(digestImage(container.image)).toBe(true);
		}
		for (const phrase of [
			"隔离分支",
			"Pull Request",
			"不接受用户粘贴的 Token",
			"bind mount",
			"privileged",
			"network_mode: host",
			"devices",
			"Helm",
			"sha256:",
			"失败原因",
		])
			expect(skill).toContain(phrase);
	});
});
