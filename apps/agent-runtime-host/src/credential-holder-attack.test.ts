import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const attacker = new URL(
	"./credential-holder-attack.test-support.mjs",
	import.meta.url,
).pathname;
const denied = ["EPERM", "EACCES"];

/** The attacker starts the target, so it is the target's parent. */
async function attack(mode: "protect" | "plain") {
	const { stdout } = await run(process.execPath, [attacker, mode]);
	return JSON.parse(stdout) as {
		dumpable: number;
		report: Record<string, string>;
	};
}

// The kernel's dumpable gate is Linux only; macOS has no equivalent procfs/prctl.
describe.skipIf(process.platform !== "linux" || process.getuid?.() === 0)(
	"same-UID access to a credential holder",
	() => {
		it("kernel refuses every access to a non-dumpable process", async () => {
			const { dumpable, report: result } = await attack("protect");
			expect(dumpable).toBe(0);
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
			const { dumpable, report: result } = await attack("plain");
			expect(dumpable).toBe(1);
			// The target is the attacker's child, so Yama 1 does not refuse these
			// either: the refusal above comes from the dumpable setting.
			expect(result.procEnviron).toBe("OK");
			expect(result.procFdList).toBe("OK");
		});
	},
);
