import { describe, expect, it } from "vitest";
import {
	agentConversationSourceLabel,
	agentSourceReferenceLabel,
} from "./agent-management-status.js";
import {
	standardTemplateLabel,
	templateDisplayName,
	templateNameLookup,
} from "./template-display-name.js";

const lookup = templateNameLookup([
	{ templateId: "codex", displayName: "Codex" },
	{ templateId: "blank", displayName: "  " },
]);
const standard = { source: { kind: "standard", templateId: "codex" } } as const;

describe("template display names (F-02)", () => {
	it("uses the deployment display name and never the raw templateId", () => {
		expect(templateDisplayName("codex", lookup)).toBe("Codex");
		expect(standardTemplateLabel("codex", lookup)).toBe("标准模板 · Codex");
		expect(agentConversationSourceLabel(standard, lookup)).toBe(
			"标准模板 · Codex",
		);
		expect(agentSourceReferenceLabel(standard, lookup)).toBe("Codex");
	});

	it.each([
		["an unknown template", "removed", lookup],
		["a blank display name", "blank", lookup],
		[
			"an unread deployment configuration",
			"codex",
			templateNameLookup(undefined),
		],
		["no lookup", "codex", undefined],
	])("falls back to 标准模板 for %s", (_case, templateId, names) => {
		expect(templateDisplayName(templateId, names)).toBe("标准模板");
		expect(standardTemplateLabel(templateId, names)).toBe("标准模板");
		expect(
			agentConversationSourceLabel(
				{ source: { kind: "standard", templateId } },
				names,
			),
		).toBe("标准模板");
		expect(
			agentSourceReferenceLabel(
				{ source: { kind: "standard", templateId } },
				names,
			),
		).not.toContain(templateId);
	});
});
