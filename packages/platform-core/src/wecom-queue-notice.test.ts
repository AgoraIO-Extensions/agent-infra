import { describe, expect, it, vi } from "vitest";
import {
	createWecomQueueNoticeV1,
	type WecomQueueNoticeV1,
	type WecomStreamUpdatePortV1,
	wecomQueuedTextV1,
	wecomQueueFullTextV1,
	wecomQueueStartedTextV1,
} from "./wecom-channel.ts";

const scope = {
	agentId: "agent",
	bindingReference: "binding",
	kind: "wecom_bot" as const,
	senderId: "sender",
	peerId: "peer",
	conversationType: "single" as const,
	threadId: null,
};

function fixture() {
	let notices: WecomQueueNoticeV1[] = [];
	const update = vi.fn<WecomStreamUpdatePortV1["update"]>(async () => "sent");
	const useCase = createWecomQueueNoticeV1({
		store: { listQueueNotices: async () => notices },
		sender: { update },
	});
	return {
		useCase,
		update,
		set(next: WecomQueueNoticeV1[]) {
			notices = next;
		},
	};
}

const notice = (receiptId: string, position: number | null) => ({
	receiptId,
	scope,
	replyHandle: `handle-${receiptId}`,
	position,
});

describe("WeCom queue notices (#3376)", () => {
	it("uses the fixed queue texts", () => {
		expect(wecomQueuedTextV1(1)).toBe(
			"已排队：第 1 位，前面还有 0 条消息，当前回复结束后按顺序处理",
		);
		expect(wecomQueuedTextV1(3)).toBe(
			"已排队：第 3 位，前面还有 2 条消息，当前回复结束后按顺序处理",
		);
		expect(wecomQueueStartedTextV1).toBe("开始处理");
		expect(wecomQueueFullTextV1(3)).toBe(
			"当前会话已有 3 条消息在排队，请等前面的消息处理后再发送",
		);
		expect(() => wecomQueuedTextV1(0)).toThrow();
	});

	it("updates the same reply on every position change and once when processing starts", async () => {
		const f = fixture();
		for (const [id, position] of [
			["one", 1],
			["two", 2],
			["three", 3],
		] as const)
			f.useCase.noted(id, position);
		f.set([notice("one", 1), notice("two", 2), notice("three", 3)]);
		// 入队首帧已由受理方发送，位次未变时不重复发送。
		expect(await f.useCase.tick()).toBe(false);
		expect(f.update).not.toHaveBeenCalled();

		f.set([notice("one", null), notice("two", 1), notice("three", 2)]);
		expect(await f.useCase.tick()).toBe(true);
		expect(
			f.update.mock.calls.map(([input]) => [input.replyHandle, input.text]),
		).toEqual([
			["handle-one", wecomQueueStartedTextV1],
			["handle-two", wecomQueuedTextV1(1)],
			["handle-three", wecomQueuedTextV1(2)],
		]);

		f.update.mockClear();
		f.set([notice("two", null), notice("three", 1)]);
		await f.useCase.tick();
		expect(
			f.update.mock.calls.map(([input]) => [input.replyHandle, input.text]),
		).toEqual([
			["handle-two", wecomQueueStartedTextV1],
			["handle-three", wecomQueuedTextV1(1)],
		]);
	});

	it("never returns to a queue notice after processing started (#3393 compatibility)", async () => {
		const f = fixture();
		f.useCase.noted("one", 1);
		f.set([notice("one", null)]);
		await f.useCase.tick();
		f.update.mockClear();
		f.set([notice("one", 1)]);
		expect(await f.useCase.tick()).toBe(false);
		expect(f.update).not.toHaveBeenCalled();
	});

	it("does not announce a start for a receipt this process never queued", async () => {
		const f = fixture();
		f.set([notice("foreign", null)]);
		expect(await f.useCase.tick()).toBe(false);
		expect(f.update).not.toHaveBeenCalled();
	});

	it("keeps going when one update fails and forgets finished receipts", async () => {
		const f = fixture();
		f.useCase.noted("one", 2);
		f.useCase.noted("two", 3);
		f.update.mockRejectedValueOnce(new Error("socket closed"));
		f.set([notice("one", 1), notice("two", 2)]);
		await f.useCase.tick();
		expect(f.update).toHaveBeenCalledTimes(2);
		// 最终回复后不再出现在列表中；之后同一回执不会再发送。
		f.set([]);
		await f.useCase.tick();
		f.update.mockClear();
		f.set([notice("one", null)]);
		await f.useCase.tick();
		expect(f.update).not.toHaveBeenCalled();
	});
});
