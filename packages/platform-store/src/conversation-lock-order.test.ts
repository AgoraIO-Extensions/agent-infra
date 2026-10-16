import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

const source = await readFile(
	new URL("./conversation-execution.ts", import.meta.url),
	"utf8",
);

function methodBody(name: string) {
	const start = source.indexOf(`async ${name}(`);
	if (start < 0) throw new Error(`Missing ${name}`);
	const next = source.indexOf("\n\tasync ", start + 1);
	return source.slice(start, next < 0 ? source.length : next);
}

it("locks Agent before Conversation for API conversation operations", () => {
	for (const method of [
		"requestMetadataRecovery",
		"executeMessage",
		"executeModelSelection",
		"executeRegeneration",
		"executeStop",
		// 聊天页轮询的读取；之前先锁会话再锁 Agent，和生命周期扇出互相死锁（#2629）。
		"readConversation",
	]) {
		const body = methodBody(method);
		const agentLock = body.indexOf("select id from platform.agents");
		const conversationLock = Math.min(
			...[
				body.indexOf("lockConversation("),
				body.indexOf("lockConversationForRead("),
			].filter((index) => index >= 0),
		);
		expect(agentLock, method).toBeGreaterThanOrEqual(0);
		expect(conversationLock, method).toBeGreaterThan(agentLock);
	}
});
