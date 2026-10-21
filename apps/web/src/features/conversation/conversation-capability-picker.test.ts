import { describe, expect, it } from "vitest";
import {
	capabilityQuery,
	filterConversationCapabilities,
	moveCapabilityIndex,
	prepareCapabilityInvocation,
	sameCapability,
} from "./conversation-capability-picker.js";

const capabilities = [
	{
		kind: "skill" as const,
		name: "workspace-summary",
		description: "Summarize approved workspace files",
		source: "skillhub",
		version: "1.0.0",
		identity: "e".repeat(64),
		directoryRevision: "d".repeat(64),
	},
	{
		kind: "command" as const,
		name: "compact",
		description: "Compact the current native session",
		source: "codex",
		version: "1.0.0",
		identity: "f".repeat(64),
		directoryRevision: "c".repeat(64),
	},
];

describe("conversation capability picker model", () => {
	it("treats only drafts starting with / as a directory query", () => {
		expect(capabilityQuery("/work")).toBe("work");
		expect(capabilityQuery("/")).toBe("");
		expect(capabilityQuery("hello /work")).toBeUndefined();
	});

	it("filters injected capabilities without creating a transport request", () => {
		expect(filterConversationCapabilities(capabilities, "workspace")).toEqual([
			capabilities[0],
		]);
		expect(filterConversationCapabilities(capabilities, "")).toEqual(
			capabilities,
		);
	});

	it("stops at the first and last option instead of wrapping", () => {
		expect(moveCapabilityIndex(0, -1, 2)).toBe(0);
		expect(moveCapabilityIndex(0, 1, 2)).toBe(1);
		expect(moveCapabilityIndex(1, 1, 2)).toBe(1);
		expect(moveCapabilityIndex(3, 1, 0)).toBe(0);
	});

	it("requires Skill parameters and submits commands without parameters", () => {
		expect(prepareCapabilityInvocation(capabilities[0], "  ")).toEqual({
			error: "请在输入框补充这次任务的目标与范围。",
		});
		expect(prepareCapabilityInvocation(capabilities[0], "列出变更")).toEqual({
			body: {
				capabilityId: "e".repeat(64),
				directoryRevision: "d".repeat(64),
				parameters: "列出变更",
			},
		});
		expect(prepareCapabilityInvocation(capabilities[1], "")).toEqual({
			body: {
				capabilityId: "f".repeat(64),
				directoryRevision: "c".repeat(64),
				parameters: "",
			},
		});
		expect(prepareCapabilityInvocation(capabilities[1], "额外内容")).toEqual({
			error: "这项只读命令不需要额外参数，请清空输入框后再发送。",
		});
	});

	it("keeps Invocation V1 without control files and upgrades a Skill to V2 with them", () => {
		expect(prepareCapabilityInvocation(capabilities[0], "列出变更")).toEqual({
			body: {
				capabilityId: "e".repeat(64),
				directoryRevision: "d".repeat(64),
				parameters: "列出变更",
			},
		});
		expect(
			prepareCapabilityInvocation(capabilities[0], "列出变更", [
				"file-2",
				"file-1",
			]),
		).toEqual({
			body: {
				capabilityId: "e".repeat(64),
				directoryRevision: "d".repeat(64),
				parameters: "列出变更",
				schemaVersion: 2,
				attachments: ["file-2", "file-1"],
			},
		});
	});

	it("rejects control files for commands, more than four files and duplicates", () => {
		expect(
			prepareCapabilityInvocation(capabilities[1], "", ["file-1"]),
		).toEqual({ error: "只读命令不接受控制文件。" });
		expect(
			prepareCapabilityInvocation(
				capabilities[0],
				"整理",
				Array.from({ length: 5 }, (_, index) => `file-${index}`),
			),
		).toEqual({ error: "最多只能附加 4 个控制文件。" });
		expect(
			prepareCapabilityInvocation(capabilities[0], "整理", [
				"file-1",
				"file-1",
			]),
		).toEqual({ error: "控制文件无效，请重新上传后再发送。" });
	});

	it("never submits a capability without its server identity", () => {
		const { identity: _identity, ...withoutIdentity } = capabilities[0];
		expect(prepareCapabilityInvocation(withoutIdentity, "目标")).toEqual({
			error: "所选版本已失效，请重新选择；不会作为普通消息发送。",
		});
	});

	it("rejects oversized UTF-8 parameter text", () => {
		expect(
			prepareCapabilityInvocation(capabilities[0], "你".repeat(4096)),
		).toEqual({ error: "补充内容过长，请缩短后再发送。" });
	});

	it("uses browser-native UTF-8 measurement for multibyte queries", () => {
		expect(
			filterConversationCapabilities(capabilities, "你".repeat(256)),
		).toEqual([]);
	});

	it("invalidates a selection when the directory revision changes", () => {
		expect(sameCapability(capabilities[0], { ...capabilities[0] })).toBe(true);
		expect(
			sameCapability(capabilities[0], {
				...capabilities[0],
				directoryRevision: "a".repeat(64),
			}),
		).toBe(false);
	});
});
