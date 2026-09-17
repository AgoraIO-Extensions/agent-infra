import { expect, it } from "vitest";
import { resolveFileLimitsV1 } from "./file-limits.ts";

it("uses the current intersection of verified Agent, Channel and deployment limits", () => {
	const base = {
		revision: "one",
		expiresAt: "2026-09-15T01:00:00Z",
		mediaTypes: ["text/plain", "image/png"],
		maxBytes: 100,
	};
	const inputs = {
		agent: base,
		channel: { ...base, maxBytes: 50 },
		deployment: { ...base, mediaTypes: ["text/plain"], maxBytes: 75 },
	};
	const now = new Date("2026-09-15T00:00:00Z");
	expect(resolveFileLimitsV1(inputs, now)).toMatchObject({
		maxBytes: 50,
		mediaTypes: ["text/plain"],
	});
	expect(resolveFileLimitsV1({ ...inputs, agent: null }, now)).toBeNull();
	expect(
		resolveFileLimitsV1(
			{ ...inputs, channel: { ...base, expiresAt: "2026-09-14T00:00:00Z" } },
			now,
		),
	).toBeNull();
});
