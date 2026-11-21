import { createServer } from "node:http";
import type { CodexAppServerFrame } from "./codex-app-server-bridge.js";
import { MetadataTransport } from "./compact-transport.test-support.js";
// 8d06's real 0.153.0 sequence: empty ACK, Turn/item start, model HTTP,
// then item/Turn completion. The model must cross the real protected transport.
export class CompactModelTransport extends MetadataTransport {
	readonly modelStatuses: number[] = [];
	rpcMode: "normal" | "nonempty" | "timeout" | "disconnect" = "normal";
	completionMode: "both" | "item-only" | "turn-only" | "failed" = "both";
	override async send(frame: CodexAppServerFrame) {
		if (frame.method !== "thread/compact/start") return super.send(frame);
		this.requests.push(frame);
		if (this.rpcMode === "timeout") return;
		if (this.rpcMode === "disconnect")
			throw new TypeError("Synthetic RPC disconnected");
		if (this.beforeSend) await this.beforeSend(frame);
		this.push({
			id: frame.id,
			result: this.rpcMode === "nonempty" ? { unexpected: true } : {},
		});
		this.push({
			method: "turn/started",
			params: {
				threadId: this.threadId,
				turn: { id: this.compactTurnId, status: "inProgress", items: [] },
			},
		});
		this.push({
			method: "item/started",
			params: {
				threadId: this.threadId,
				turnId: this.compactTurnId,
				item: { type: "contextCompaction", id: this.compactItemId },
			},
		});
		void this.model().catch(() => this.failed());
	}
	private failed() {
		this.push({
			method: "turn/completed",
			params: {
				threadId: this.threadId,
				turn: { id: this.compactTurnId, status: "failed", items: [] },
			},
		});
	}
	private async model() {
		const access = this.options?.modelAccess;
		if (!access) throw new Error("Missing protected model transport");
		const response = await fetch(`${access.endpoint}/responses`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${access.credential}`,
				"content-type": "application/json",
				"x-client-request-id": this.threadId,
				"x-codex-turn-metadata": JSON.stringify({
					thread_id: this.threadId,
					turn_id: this.compactTurnId,
				}),
			},
			body: JSON.stringify({
				model: this.options?.model,
				reasoning: { effort: this.options?.reasoningEffort ?? "high" },
				input: [
					{
						role: "user",
						content: [{ type: "input_text", text: "Synthetic summary input" }],
					},
				],
			}),
		});
		this.modelStatuses.push(response.status);
		await response.text();
		if (!response.ok) return this.failed();
		if (!this.holdCompactTerminal) {
			if (this.completionMode === "both") this.completeCompact();
			else if (this.completionMode === "failed") this.failed();
			else if (this.completionMode === "item-only")
				this.push({
					method: "item/completed",
					params: {
						threadId: this.threadId,
						turnId: this.compactTurnId,
						item: { type: "contextCompaction", id: this.compactItemId },
					},
				});
			else
				this.push({
					method: "turn/completed",
					params: {
						threadId: this.threadId,
						turn: { id: this.compactTurnId, status: "completed", items: [] },
					},
				});
		}
	}
}

export async function startCompactMockModel(gated = false) {
	const gate = Promise.withResolvers<void>();
	if (!gated) gate.resolve();
	const requests: { key: string | undefined }[] = [];
	const server = createServer(async (request, response) => {
		for await (const _ of request) {
			/* Never retain the model request. */
		}
		requests.push({ key: request.headers.authorization });
		await gate.promise;
		response.writeHead(200, { "content-type": "text/event-stream" });
		const item = {
			type: "message",
			id: "synthetic-summary",
			role: "assistant",
			content: [{ type: "output_text", text: "Synthetic summary" }],
		};
		for (const event of [
			{ type: "response.created", response: { id: "synthetic-response" } },
			{ type: "response.output_item.done", item },
			{
				type: "response.completed",
				response: {
					id: "synthetic-response",
					status: "completed",
					usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				},
			},
		])
			response.write(
				`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
			);
		response.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing mock address");
	return {
		endpoint: `http://127.0.0.1:${address.port}/v1`,
		requests,
		release: () => gate.resolve(),
		close: () => {
			gate.resolve();
			return new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
