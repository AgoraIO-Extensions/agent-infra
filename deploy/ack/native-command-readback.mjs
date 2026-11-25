import { setTimeout as delay } from "node:timers/promises";

const terminal = new Set(["completed", "failed", "cancelled"]);

// Both reads use the original Conversation URL and execution ID. This loop has no submit path.
export async function readNativeCommandTerminal({ executionId, readDetail, reconnect, timeoutMs = 180_000, intervalMs = 2_000 }) {
	const readStatus = async () => {
		const detail = await readDetail();
		const event = detail.events.findLast(entry =>
			entry.type === "execution.status" && entry.executionId === executionId);
		return event?.payload?.status ?? "unknown";
	};
	const deadline = Date.now() + timeoutMs;
	let terminalStatus = await readStatus();
	while (!terminal.has(terminalStatus) && Date.now() < deadline) {
		await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
		terminalStatus = await readStatus();
	}
	await reconnect();
	return { terminalStatus, reconnectedStatus: await readStatus() };
}

export function reviewReadbackPassed(value) {
	return value?.command === "/review" && Object.keys(value).every(key =>
		["command", "invocationCount", "executionHash", "httpStatus", "terminalStatus", "reconnectedStatus"].includes(key)) && value.httpStatus === 202 &&
		value.invocationCount === 1 && typeof value.executionHash === "string" &&
		/^[a-f0-9]{64}$/u.test(value.executionHash) &&
		value.terminalStatus === "completed" && value.reconnectedStatus === "completed";
}
