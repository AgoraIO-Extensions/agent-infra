import type { PaseoAgentTimelineEvent } from "@getpaseo/client";
import { z } from "zod";
import {
	type openCodeDeploymentReadActions,
	openCodeDeploymentSkillInstructions,
} from "./opencode-deployment-skills.js";
import type { PaseoTransport } from "./paseo-transport.js";
import type { NativeSessionOptions } from "./session-runtime-driver.js";

type Request = Extract<
	PaseoAgentTimelineEvent["event"],
	{ type: "permission_requested" }
>["request"];
type Page = Awaited<ReturnType<PaseoTransport["timeline"]>>;
type Actions = ReturnType<typeof openCodeDeploymentReadActions>;
export interface OpenCodePaseoRead {
	actions: Pick<Actions, "allow" | "finishTool" | "entriesForPrompt">;
	writeInstructions(text: string): Promise<void>;
	respond: PaseoTransport["respondToPermission"];
}
const metadata = z.object({
	toolCallId: z.string().min(1),
	rawRequest: z.object({
		sessionId: z.string().min(1),
		toolCall: z.object({
			toolCallId: z.string(),
			title: z.literal("read"),
			kind: z.literal("read"),
		}),
		options: z.array(
			z.object({ optionId: z.string().min(1), kind: z.string() }),
		),
	}),
});
export function openPaseoReadTurn(
	session: NativeSessionOptions,
	read: OpenCodePaseoRead,
	signal: AbortSignal,
) {
	const seen = new Set<string>();
	const calls = new Set<string>();
	const pending: Request[] = [];
	const rejected = new Set<string>();
	const running = new Set<string>();
	let commands: readonly { name: string }[] = [];
	async function answer(request: Request, page: Page, turnId: string) {
		const id = session.runtimeSessionRef;
		const meta = metadata.safeParse(request.metadata).data;
		const options = meta?.rawRequest.options ?? [];
		const uniqueOption = (kind: string) => {
			const matches = options.filter((option) => option.kind === kind);
			const value = matches[0]?.optionId;
			return matches.length === 1 &&
				options.filter((option) => option.optionId === value).length === 1
				? value
				: undefined;
		};
		const allow = uniqueOption("allow_once");
		const deny = uniqueOption("reject_once");
		const callId = meta?.toolCallId;
		const rows = page.entries.filter(
			(row) => row.item.type === "tool_call" && row.item.callId === callId,
		);
		const row = rows[0];
		const original = rows.length === 1 && row?.turnId === turnId;
		const file =
			request.detail?.type === "read" ? request.detail.filePath : undefined;
		let current: false | (() => void) = false;
		if (
			meta &&
			callId &&
			allow &&
			deny &&
			original &&
			row.item.type === "tool_call" &&
			row.item.name === "read" &&
			row.item.status === "running" &&
			row.item.detail.type === "read" &&
			row.item.detail.filePath === file &&
			file &&
			request.provider === "acp" &&
			request.kind === "tool" &&
			request.name === "read" &&
			page.agent?.id === id &&
			page.agent.provider === "agent-infra-opencode" &&
			page.agent.persistence?.sessionId === meta.rawRequest.sessionId &&
			callId === meta.rawRequest.toolCall.toolCallId &&
			!calls.has(callId)
		) {
			calls.add(callId);
			signal.throwIfAborted();
			try {
				current = await read.actions.allow(callId, file, commands);
			} catch {
				// An ambiguous or withdrawn source still needs an explicit one-time refusal.
				current = false;
			}
			if (current) running.add(callId);
		}
		// The official reply is made once, including when its acknowledgment is lost.
		await read.respond(id, request.id, () => {
			if (current && allow) {
				try {
					signal.throwIfAborted();
					current();
					return { behavior: "allow", selectedActionId: allow };
				} catch {
					/* The original grant expired before the reply. */
				}
			}
			if (original && callId) rejected.add(callId);
			return { behavior: "deny", ...(deny ? { selectedActionId: deny } : {}) };
		});
	}

	return {
		async prepare(rows: readonly { name: string }[]) {
			commands = rows;
			await read.writeInstructions(
				openCodeDeploymentSkillInstructions(
					read.actions.entriesForPrompt(rows),
				),
			);
		},
		request(request: Request) {
			if (seen.has(request.id)) return;
			seen.add(request.id);
			pending.push(request);
		},
		async reconcile(page: Page, turnId: string) {
			for (const request of pending.splice(0))
				await answer(request, page, turnId);
			let failed = false;
			for (const row of page.entries) {
				const item = row.item;
				if (row.turnId !== turnId || item.type !== "tool_call") continue;
				if (item.status !== "completed" && item.status !== "failed") continue;
				if (running.delete(item.callId)) {
					await read.actions.finishTool(item.callId, item.status);
					if (item.status === "failed") rejected.add(item.callId);
				}
				if (item.status === "failed" && rejected.has(item.callId))
					failed = true;
			}
			return failed;
		},
		async close() {
			for (const callId of running)
				await read.actions.finishTool(callId, "unknown");
		},
	};
}
