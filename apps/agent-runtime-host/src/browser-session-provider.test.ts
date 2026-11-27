import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSessionBrowserExecutionContextV1 } from "./browser-session-provider.js";

const unavailable = {
	status: "not_configured",
	capabilityVersion: 1,
	schemaVersion: 1,
	errorCode: "BROWSER_CAPABILITY_NOT_CONFIGURED",
	reason: "missing",
	retryable: false,
} as const;
const binding = {
	subjectId: "user-1",
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	sessionGeneration: 1,
	resourceFence: 1,
	capabilityVersion: 1,
	pageRevision: 1,
	workloadRevision: 1,
	imageDigest: `registry.example/runtime@sha256:${"a".repeat(64)}`,
};

describe("createSessionBrowserExecutionContextV1", () => {
	it.each([
		["relative sandbox", { sandboxRoot: "relative" }],
		["root sandbox", { sandboxRoot: "/" }],
		[
			"unavailable capability",
			{ sandboxRoot: "/workspace", capability: unavailable },
		],
		[
			"invalid binding",
			{ sandboxRoot: "/workspace", binding: { ...binding, resourceFence: 0 } },
		],
	])("fails closed for %s", (_name, override) => {
		const input = Object.assign(
			{ capability: {} as never, binding, sandboxRoot: "/workspace" },
			override,
		);
		expect(() => createSessionBrowserExecutionContextV1(input)).toThrow();
	});

	it("drops an oversized retained profile on close and preserves the Session workspace", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-profile-"));
		try {
			const profile = join(root, "browser-profile");
			await mkdir(profile);
			await writeFile(join(profile, "cache"), Buffer.alloc(16384));
			await writeFile(join(root, "report.txt"), "test");
			const context = createSessionBrowserExecutionContextV1({
				sandboxRoot: root,
				binding,
				capability: {
					status: "available",
					schemaVersion: 1,
					capabilityVersion: 1,
					operations: ["observe"],
					policy: { maxRetainedProfileBytes: 8192 } as never,
					provenance: {} as never,
					conformance: {} as never,
				},
			});
			await context.close?.();
			await expect(stat(profile)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(stat(join(root, "report.txt"))).resolves.toMatchObject({
				size: 4,
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("accepts the readiness binding's bare image digest", () => {
		const context = createSessionBrowserExecutionContextV1({
			sandboxRoot: "/workspace",
			capability: {
				status: "available",
				schemaVersion: 1,
				capabilityVersion: 1,
				operations: ["observe"],
				policy: {} as never,
				provenance: {} as never,
				conformance: {} as never,
			},
			binding: {
				...binding,
				imageDigest: `sha256:${"a".repeat(64)}`,
			},
		});
		expect(context.binding.imageDigest).toBe(`sha256:${"a".repeat(64)}`);
	});
});
