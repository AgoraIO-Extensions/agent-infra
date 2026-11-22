import { describe, expect, it } from "vitest";

import {
	RuntimeSafetyEvidenceLogAckResponseV1Schema,
	RuntimeSafetyEvidenceWindowV1Schema,
	runtimeSafetyEvidencePrincipalRefV1,
} from "./safety-evidence-window-v1.ts";

const window = {
	schemaVersion: 1,
	windowRef: "window-1",
	opensAt: "2026-11-22T00:00:00.000Z",
	closesAt: "2026-11-22T02:00:00.000Z",
	agentIds: ["agent-1"],
	principalRefs: ["p1-principal"],
	scenarios: [
		{
			id: "u1-file",
			version: 1,
			resourceClasses: ["file"],
			actionClasses: ["read"],
		},
	],
	producers: [{ kind: "native_helper", version: "u1-helper-1" }],
};

describe("acceptance window (Spec §18.5.1 验收场景)", () => {
	it("accepts one bounded window", () => {
		expect(RuntimeSafetyEvidenceWindowV1Schema.parse(window)).toEqual(window);
	});

	it.each([
		["an empty window", { closesAt: window.opensAt }],
		["a window longer than 72 hours", { closesAt: "2026-11-25T00:00:01.000Z" }],
		["a repeated Agent", { agentIds: ["agent-1", "agent-1"] }],
		["a repeated subject", { principalRefs: ["p1-a", "p1-a"] }],
		["no subject", { principalRefs: [] }],
		["an unknown field", { secret: "x" }],
		[
			"an unknown resource class",
			{
				scenarios: [{ ...window.scenarios[0], resourceClasses: ["network"] }],
			},
		],
		[
			"a repeated producer",
			{ producers: [window.producers[0], window.producers[0]] },
		],
	])("refuses %s", (_name, change) => {
		expect(
			RuntimeSafetyEvidenceWindowV1Schema.safeParse({ ...window, ...change })
				.success,
		).toBe(false);
	});

	it("keeps the ACK receipt strict", () => {
		expect(
			RuntimeSafetyEvidenceLogAckResponseV1Schema.safeParse({
				schemaVersion: 1,
				acknowledged: "se1-1",
				extra: true,
			}).success,
		).toBe(false);
	});
});

describe("principal reference", () => {
	it("is a fixed pseudonymous reference per subject kind and id", async () => {
		const user = await runtimeSafetyEvidencePrincipalRefV1({
			kind: "user",
			id: "user-1",
		});
		expect(user).toMatch(/^p1-[a-f0-9]{64}$/);
		expect(user).not.toContain("user-1");
		expect(
			await runtimeSafetyEvidencePrincipalRefV1({ kind: "user", id: "user-1" }),
		).toBe(user);
		expect(
			await runtimeSafetyEvidencePrincipalRefV1({
				kind: "application",
				id: "user-1",
			}),
		).not.toBe(user);
		expect(
			await runtimeSafetyEvidencePrincipalRefV1({ kind: "user", id: "user-2" }),
		).not.toBe(user);
	});
});
