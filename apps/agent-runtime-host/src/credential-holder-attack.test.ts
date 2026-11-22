import { type ChildProcess, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const target = new URL(
	"./credential-holder-target.test-support.mjs",
	import.meta.url,
).pathname;
const attacker = new URL(
	"./credential-holder-attack.test-support.mjs",
	import.meta.url,
).pathname;
const denied = ["EPERM", "EACCES"];
const children: ChildProcess[] = [];

afterEach(() => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
});

async function startTarget(mode: "protect" | "plain") {
	const child = spawn(process.execPath, [target, mode], {
		stdio: ["ignore", "pipe", "ignore"],
	});
	children.push(child);
	const line = await new Promise<string>((resolve, reject) => {
		let text = "";
		child.stdout.on("data", (chunk) => {
			text += chunk;
			if (text.includes("\n")) resolve(text);
		});
		child.once("exit", (code) => reject(new Error(`target exited ${code}`)));
	});
	const [, pid, dumpable] = line.trim().split(" ");
	return { pid: Number(pid), dumpable: Number(dumpable) };
}

async function attack(pid: number) {
	const { stdout } = await run(process.execPath, [attacker, String(pid)]);
	return JSON.parse(stdout) as Record<string, string>;
}

// The kernel's dumpable gate is Linux only; macOS has no equivalent procfs/prctl.
describe.skipIf(process.platform !== "linux" || process.getuid?.() === 0)(
	"same-UID access to a credential holder",
	() => {
		it("kernel refuses every access to a non-dumpable process", async () => {
			const holder = await startTarget("protect");
			expect(holder.dumpable).toBe(0);
			const result = await attack(holder.pid);
			expect(Object.keys(result).sort()).toEqual([
				"pidfdGetfd",
				"procEnviron",
				"procFdList",
				"procMem",
				"processVmReadv",
				"ptraceAttach",
				"ptraceSeize",
			]);
			for (const [access, code] of Object.entries(result))
				expect([access, denied.includes(code)]).toEqual([access, true]);
		});

		it("control: the same accesses are not all refused for a dumpable process", async () => {
			const plain = await startTarget("plain");
			expect(plain.dumpable).toBe(1);
			const result = await attack(plain.pid);
			// Yama may still refuse ATTACH-mode accesses; the READ-mode ones prove
			// the refusal above comes from the dumpable setting.
			expect(result.procEnviron).toBe("OK");
			expect(result.procFdList).toBe("OK");
		});
	},
);
