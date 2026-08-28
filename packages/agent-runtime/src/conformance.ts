export const runtimeDriverConformanceTable = [
	{ capability: "turn", expected: "accepted" },
	{ capability: "event", expected: "status" },
	{ capability: "supplement", expected: "accepted" },
	{ capability: "busy", expected: "busy" },
	{ capability: "stop", expected: "accepted" },
	{ capability: "status", expected: "cancelled" },
	{ capability: "capabilities", expected: true },
	{ capability: "rejected", expected: "rejected" },
] as const;
