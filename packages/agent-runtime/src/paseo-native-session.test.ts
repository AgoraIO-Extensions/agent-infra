import { expect, it, vi } from "vitest";
import { openPaseoNativeSession } from "./paseo-native-session.js";

it("requires the original SDK agent on resume and never recreates an absent one", async () => {
	const id = "8a09d2ce-a488-44f8-999f-431117a1d900";
	const ensureAgent = vi.fn();
	const close = vi.fn(async () => {});
	const transport = {
		refetchAgent: vi.fn(async () => false),
		ensureAgent,
		close,
	};
	await expect(
		openPaseoNativeSession({
			session: { runtimeSessionRef: id, nativeId: `paseo:${id}` },
			model: "configured/test",
			transport,
			close,
		} as never),
	).rejects.toThrow("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
	expect(transport.refetchAgent).toHaveBeenCalledWith(id);
	expect(ensureAgent).not.toHaveBeenCalled();
});

it.each([true, false])(
	"binds the terminal to the original message and the confirmed model reply (%s)",
	async (confirmed) => {
		const id = "8a09d2ce-a488-44f8-999f-431117a1d900";
		const executionId = "execution-a";
		const update = vi.fn();
		let fire: (value: unknown) => void = () => {};
		const unsubscribe = vi.fn();
		let messageId = "";
		const transport = {
			ensureAgent: vi.fn(),
			subscribe: vi.fn(async (_: string, f: typeof fire) => {
				fire = f;
				return unsubscribe;
			}),
			send: vi.fn(async (_: string, msg: string) => {
				messageId = msg;
				fire({
					agentId: id,
					event: { type: "turn_completed", turnId: "wrong" },
				});
				fire({
					agentId: id,
					event: { type: "turn_completed", turnId: "original" },
				});
			}),
			timeline: vi.fn(async () => ({
				agentId: id,
				epoch: "a",
				entries: [
					{
						seqStart: 1,
						turnId: "original",
						item: {
							type: "user_message",
							text: "hello",
							clientMessageId: messageId,
						},
					},
					{
						seqStart: 2,
						turnId: "wrong",
						item: { type: "assistant_message", text: "unrelated" },
					},
					{
						seqStart: 3,
						turnId: "original",
						item: { type: "assistant_message", text: "answer" },
					},
				],
			})),
		};
		const native = await openPaseoNativeSession({
			session: { runtimeSessionRef: id, executionId, admit: vi.fn(), update },
			model: "configured/test",
			transport,
			close: vi.fn(),
			hasConfirmedModelTurn: () => confirmed,
		} as never);
		if (!confirmed) {
			await expect(native.prompt("hello")).rejects.toThrow(
				"RUNTIME_ACCEPTANCE_UNKNOWN",
			);
			expect(update).not.toHaveBeenCalled();
			return;
		}
		expect(await native.prompt("hello")).toMatchObject({ stopReason: "stop" });
		expect(update).toHaveBeenCalledWith({
			type: "text",
			payload: { delta: "answer" },
		});
		expect(update).not.toHaveBeenCalledWith({
			type: "text",
			payload: { delta: "unrelated" },
		});
		expect(unsubscribe).toHaveBeenCalled();
	},
);
