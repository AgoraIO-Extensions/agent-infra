const terminalStatuses = new Set(["completed", "failed", "cancelled"]);

export function validateNativeCommandReadback(value) {
	const reasons = [];
	if (!value || typeof value !== "object" || Array.isArray(value))
		return { status: "blocked", reasons: ["readback:shape"] };
	if (value.httpStatus !== 202) reasons.push("readback:http-status");
	if (typeof value.executionId !== "string" || value.executionId.length === 0)
		reasons.push("readback:execution-id");
	if (!terminalStatuses.has(value.terminalStatus))
		reasons.push("readback:terminal-status");
	if (value.reconnected !== true) reasons.push("readback:reconnect");
	if (value.initialRequestCount !== 1) reasons.push("readback:duplicate-submit");
	return reasons.length ? { status: "blocked", reasons } : { status: "passed" };
}
