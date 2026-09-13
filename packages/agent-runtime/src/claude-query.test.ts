import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, expect, it, vi } from "vitest";
import { claudeQuery } from "./claude-query.js";

const fixture = vi.hoisted(() => ({
	script: "",
	child: undefined as ChildProcessWithoutNullStreams | undefined,
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: ({ options }: { options: Options }) => {
		fixture.child = options.spawnClaudeCodeProcess?.({
			command: process.execPath,
			args: ["-e", fixture.script],
			cwd: process.cwd(),
			env: process.env,
			signal: new AbortController().signal,
		}) as ChildProcessWithoutNullStreams;
		return { close() {} };
	},
}));

afterEach(async () => {
	vi.restoreAllMocks();
	const child = fixture.child;
	if (!child?.pid) return;
	const closed = child.exitCode !== null || child.signalCode !== null;
	const exit = closed ? Promise.resolve() : once(child, "close");
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
	await exit;
});

async function start(script: string) {
	fixture.script = script;
	const handle = claudeQuery({} as Options, {} as SDKUserMessage);
	const child = fixture.child;
	if (!child?.pid) throw new Error("Synthetic child did not start");
	await once(child.stdout, "data");
	return { ...handle, pid: child.pid };
}

it("retires the entire native group after its leader closes", async () => {
	const handle = await start(`
const {spawn} = require('node:child_process');
const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"], {stdio:['ignore','ignore','ignore','ipc']});
descendant.once('message',()=>process.stdout.write('ready'));
setInterval(()=>{},1000);
`);
	const nativeKill = process.kill.bind(process);
	const signals: (number | string | undefined)[] = [];
	vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
		if (pid === -handle.pid) signals.push(signal);
		return nativeKill(pid, signal);
	});
	await handle.close();
	expect(signals).toContain("SIGKILL");
	expect(() => nativeKill(-handle.pid, 0)).toThrow();
}, 10000);

it.each(["denied", "no-exit"])(
	"bounds retirement when SIGKILL is %s",
	async (failure) => {
		const handle = await start(
			"process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)",
		);
		const nativeKill = process.kill.bind(process);
		let attempted = false;
		vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			if (pid === -handle.pid && signal === "SIGKILL") {
				attempted = true;
				if (failure === "denied")
					throw Object.assign(new Error("Synthetic kill denial"), {
						code: "EPERM",
					});
				return true;
			}
			return nativeKill(pid, signal);
		});
		await expect(handle.close()).rejects.toThrow(
			"RUNTIME_NATIVE_SESSION_UNAVAILABLE",
		);
		expect(attempted).toBe(true);
	},
	6000,
);
