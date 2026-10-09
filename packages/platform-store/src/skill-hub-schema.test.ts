import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
	skillHubAgentBindings,
	skillHubSkills,
	skillHubVersions,
} from "./schema-skill-hub.ts";

describe("Skill Hub persistence schema", () => {
	it("supports the composite version owner foreign key", () => {
		const skills = getTableConfig(skillHubSkills);
		expect(skills.indexes.map((index) => index.config.name)).toContain(
			"skill_hub_skill_id_owner_unique",
		);
	});

	it("allows submitted shared versions before review", () => {
		const versions = getTableConfig(skillHubVersions);
		const reviewCheck = versions.checks.find(
			(check) => check.name === "skill_hub_version_review_binding",
		);
		expect(reviewCheck).toBeDefined();
		expect(
			readFileSync(
				new URL(
					"../../../migrations/platform/0039_skill_hub.sql",
					import.meta.url,
				),
				"utf8",
			),
		).toContain(`"state" = 'pending_review' or`);
	});

	it("binds every row to the configuration revision", () => {
		const binding = getTableConfig(skillHubAgentBindings);
		expect(binding.columns.map((column) => column.name)).toContain(
			"configuration_revision",
		);
		expect(binding.foreignKeys).toHaveLength(3);
		expect(
			binding.primaryKeys[0]?.columns.map((column) => column.name),
		).toEqual([
			"agent_id",
			"agent_version",
			"configuration_revision",
			"skill_version_id",
		]);
	});
});
