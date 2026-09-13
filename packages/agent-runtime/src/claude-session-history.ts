import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const sdk = createRequire(import.meta.url).resolve(
	"@anthropic-ai/claude-agent-sdk",
);
// SDK history helpers resolve CLAUDE_CONFIG_DIR in their own process, never a shared global mutation.
const script = `
const {getSessionInfo, getSessionMessages} = await import(process.argv[1]);
const [id, dir, userId] = process.argv.slice(2);
const info = await getSessionInfo(id, {dir});
if (!info || info.sessionId !== id) process.exit(1);
const messages = await getSessionMessages(id, {dir});
if (messages.some(m => m.session_id !== id || m.parent_tool_use_id !== null)) process.exit(1);
const start = messages.findIndex(m => m.uuid === userId && m.type === 'user');
const tail = start < 0 ? [] : messages.slice(start + 1);
const last = tail.at(-1);
const events = [];
for (const entry of tail) {
 const content = entry.message?.content;
 if (!Array.isArray(content)) continue;
 for (const block of content) {
  if (entry.type === 'assistant' && block.type === 'text') events.push({type:'text', payload:{delta:block.text}});
  if (entry.type === 'assistant' && block.type === 'tool_use') events.push({type:'tool', payload:{id:block.id, name:block.name, phase:'started'}});
  if (entry.type === 'user' && block.type === 'tool_result') events.push({type:'tool', payload:{id:block.tool_use_id, phase:block.is_error ? 'failed' : 'completed'}});
 }
}
process.stdout.write(JSON.stringify({users: messages.filter(m => m.type === 'user').map(m => m.uuid), completed: last?.type === 'assistant' && last.message?.stop_reason === 'end_turn', events}));
`;

export async function readClaudeSessionHistory(
	id: string,
	workspace: string,
	config: string,
	userId?: string,
) {
	try {
		const { stdout } = await promisify(execFile)(
			process.execPath,
			["--input-type=module", "-e", script, sdk, id, workspace, userId ?? ""],
			{
				env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: config },
				timeout: 10_000,
				maxBuffer: 1_048_576,
			},
		);
		const value = JSON.parse(stdout);
		if (
			!Array.isArray(value.users) ||
			value.users.some((id: unknown) => typeof id !== "string")
		)
			throw new Error();
		return {
			users: value.users as string[],
			completed: value.completed === true,
			events: value.events as {
				type: "text" | "tool";
				payload: {
					delta?: string;
					id?: string;
					name?: string;
					phase?: "started" | "completed" | "failed";
				};
			}[],
		};
	} catch {
		throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
	}
}
