import { describe, expect, it } from "vitest";
import {
	capabilityFailedNotice,
	capabilityKindLabel,
	capabilityReceiptBusy,
	capabilityReceiptLabels,
	capabilityReceiptPhase,
	capabilityRejectionMessage,
	capabilityVersionLabel,
} from "./conversation-capability-lifecycle.js";

describe("conversation capability lifecycle", () => {
	it("derives every receipt phase from the execution status", () => {
		expect(
			[
				undefined,
				"submitted",
				"processing",
				"completed",
				"failed",
				"unknown",
				"cancelled",
			].map(
				(status) =>
					capabilityReceiptLabels[
						capabilityReceiptPhase(
							status as Parameters<typeof capabilityReceiptPhase>[0],
						)
					],
			),
		).toEqual([
			"已受理，尚未开始",
			"已受理，尚未开始",
			"正在执行",
			"已完成",
			"调用失败",
			"结果待核实",
			"已停止",
		]);
	});

	it("keeps the composer locked while accepted, running or unverified", () => {
		expect(capabilityReceiptBusy("accepted")).toBe(true);
		expect(capabilityReceiptBusy("running")).toBe(true);
		expect(capabilityReceiptBusy("unknown")).toBe(true);
		expect(capabilityReceiptBusy("completed")).toBe(false);
		expect(capabilityReceiptBusy("failed")).toBe(false);
		expect(capabilityReceiptBusy("cancelled")).toBe(false);
	});

	it("maps every rejection to a readable reason without the raw outcome", () => {
		for (const outcome of [
			"busy",
			"stale",
			"disabled",
			"invalid_parameters",
			"unsupported",
			"unavailable",
			"conflict",
			"denied",
		]) {
			const message = capabilityRejectionMessage(outcome);
			expect(message).not.toContain(outcome);
			expect(message).toContain("没有降级为普通消息");
		}
		expect(capabilityRejectionMessage("denied", "authorization_lost")).toBe(
			"当前账号已无权使用所选命令或 Skill，请重新选择。内容没有降级为普通消息。",
		);
		expect(capabilityFailedNotice).toBe(
			"所选版本加载失败。内容没有降级为普通消息。",
		);
	});

	it("labels the kind and version as the design does", () => {
		expect(capabilityKindLabel("skill")).toBe("Skill");
		expect(capabilityKindLabel("command")).toBe("原生命令");
		expect(capabilityVersionLabel("skill", "1.0.0")).toBe("v1.0.0");
		expect(capabilityVersionLabel("command", "1.0.0")).toBe("1.0.0");
		expect(capabilityVersionLabel("skill", undefined)).toBeUndefined();
	});
});
