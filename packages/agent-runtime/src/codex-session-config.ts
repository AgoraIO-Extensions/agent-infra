// Hosted web search and subagent inference require their own model authorization.
export const codexModelToolConfig = Object.freeze({
	web_search: "disabled",
	"features.multi_agent": false,
	"features.multi_agent_v2": false,
});

/** Both native launchers keep notes and read instructions in this Session's CODEX_HOME. */
export const codexSessionMemoryConfig = Object.freeze({
	"features.memories": true,
	"memories.use_memories": true,
	"memories.dedicated_tools": true,
	// 0.153.0 starts extraction outside a user Turn and consolidates on a new thread.
	"memories.generate_memories": false,
});
