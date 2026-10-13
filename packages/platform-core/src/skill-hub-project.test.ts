import { describe, expect, it } from "vitest";
import {
	parseSkillHubProjectCreateV1,
	parseSkillHubProjectUpdateV1,
} from "./skill-hub-project.js";

describe("Skill Hub project commands", () => {
	it("parses strict create and update commands", () => {
		expect(
			parseSkillHubProjectCreateV1({
				schemaVersion: 1,
				name: "workspace-summary",
				organizationId: "org-a",
			}),
		).toEqual({
			schemaVersion: 1,
			name: "workspace-summary",
			organizationId: "org-a",
		});
		expect(
			parseSkillHubProjectUpdateV1({
				schemaVersion: 1,
				status: "disabled",
			}),
		).toEqual({ schemaVersion: 1, status: "disabled" });
	});

	it("rejects ownership and empty updates", () => {
		for (const value of [
			{ schemaVersion: 1, name: "UPPER" },
			{ schemaVersion: 1 },
			{ schemaVersion: 1, name: "valid", ownerId: "foreign" },
		]) {
			expect(() => parseSkillHubProjectUpdateV1(value)).toThrow();
		}
	});
});
