import assert from "node:assert/strict";

export function conversationTurns(input: Record<string, unknown>) {
	const follows = input.followUpPrompts ?? [];
	assert(Array.isArray(follows) && follows.length <= 4, "TURN_PLAN_INVALID");
	const prompts = [input.prompt, ...follows];
	assert(
		prompts.every(
			(prompt) =>
				typeof prompt === "string" &&
				prompt.trim().length > 0 &&
				prompt.length <= 16_384,
		),
		"TURN_PLAN_INVALID",
	);
	const expected = input.expectedReplies;
	if (prompts.length > 1 || expected !== undefined) {
		assert(
			Array.isArray(expected) &&
				expected.length === prompts.length &&
				expected.every(
					(reply) =>
						typeof reply === "string" &&
						reply.trim().length > 0 &&
						reply.length <= 16_384,
				),
			"TURN_EXPECTATIONS_REQUIRED",
		);
	}
	return prompts.map((prompt, index) => ({
		prompt: prompt as string,
		expectedReply: Array.isArray(expected)
			? (expected[index] as string)
			: undefined,
	}));
}

export function assertTurnReply(actual: string, expected: string | undefined) {
	assert(actual.trim().length > 0, "EMPTY_TURN_REPLY");
	// Fixed test prompts have exact expected replies; never place either body in an assertion diagnostic.
	if (expected !== undefined)
		assert(actual.trim() === expected.trim(), "TURN_REPLY_MISMATCH");
}
