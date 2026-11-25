// Executed inside the original Pi Pod. Journal contents must stay inside it.
const fs = require("node:fs");
const path = require("node:path");
try {
	const [root, agentId, conversationId, generation, executionId, turnId, revision] = process.argv.slice(1);
	function read(file) {
		if (fs.realpathSync(file) !== file || fs.statSync(file).size > 10_000_000) throw new Error();
		return JSON.parse(fs.readFileSync(file, "utf8"));
	}
	const match = binding => binding.agentId === agentId && binding.conversationId === conversationId &&
		binding.sessionGeneration === Number(generation);
	const bindings = read(path.join(root, "index.json")).sessions.filter(match);
	if (bindings.length !== 1 || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(bindings[0].ref)) throw new Error();
	const ref = bindings[0].ref;
	const state = read(path.join(root, ref, "state.json"));
	if (!match(state.binding) || state.binding.ref !== ref || state.nativeId !== "paseo:" + ref) throw new Error();
	const turns = state.turns.filter(turn => turn.executionId === executionId);
	if (turns.length !== 1 || turns[0].turnId !== turnId || turns[0].status !== "completed" || turns[0].configVersion !== revision) throw new Error();
	process.stdout.write("1");
} catch {
	process.exitCode = 1;
}
