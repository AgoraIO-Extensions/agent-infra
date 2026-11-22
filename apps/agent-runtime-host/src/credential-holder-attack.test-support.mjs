// Same-UID attacker for credential-holder-attack.test.ts. It starts the target
// itself, so the target is its descendant and Yama ptrace_scope 1 would permit
// ATTACH: any refusal then comes from the dumpable state. It only reports the
// errno of each access attempt. It never reads or prints target memory,
// environment or file contents.

import { spawn } from "node:child_process";
import { closeSync, openSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { constants } from "node:os";

const koffi = createRequire(import.meta.url)("koffi");
const targetPath = new URL(
	"./credential-holder-target.test-support.mjs",
	import.meta.url,
).pathname;
const child = spawn(process.execPath, [targetPath, process.argv[2]], {
	stdio: ["ignore", "pipe", "ignore"],
});
const ready = await new Promise((resolve, reject) => {
	let text = "";
	child.stdout.on("data", (chunk) => {
		text += chunk;
		if (text.includes("\n")) resolve(text);
	});
	child.once("exit", (code) => reject(new Error(`target exited ${code}`)));
});
const [, targetPid, dumpable] = ready.trim().split(" ");
const pid = Number(targetPid);
const names = new Map(
	Object.entries(constants.errno).map(([name, value]) => [value, name]),
);
const libc = koffi.load("libc.so.6");
const ptrace = libc.func(
	"long ptrace(int request, int pid, void *addr, void *data)",
);
const syscall = libc.func("long syscall(long number, ...)");
// Registered by name for the process_vm_readv signature below.
koffi.struct("iovec_local", { base: "void *", len: "size_t" });
koffi.struct("iovec_remote", {
	base: "uintptr_t",
	len: "size_t",
});
const processVmReadv = libc.func(
	"long process_vm_readv(int pid, iovec_local *local, unsigned long liovcnt, iovec_remote *remote, unsigned long riovcnt, unsigned long flags)",
);
const PTRACE_ATTACH = 16;
const PTRACE_SEIZE = 0x4206;
// Generic syscall numbers on x86_64 and arm64.
const SYS_PIDFD_OPEN = 434;
const SYS_PIDFD_GETFD = 438;

const outcome = (result) =>
	result === -1 ? (names.get(koffi.errno()) ?? `ERRNO_${koffi.errno()}`) : "OK";
const attempt = (action) => {
	try {
		return action();
	} catch (error) {
		return error?.code ?? "THROWN";
	}
};

const report = {
	ptraceAttach: outcome(ptrace(PTRACE_ATTACH, pid, null, null)),
	ptraceSeize: outcome(ptrace(PTRACE_SEIZE, pid, null, null)),
	processVmReadv: outcome(
		processVmReadv(
			pid,
			{ base: Buffer.alloc(8), len: 8 },
			1,
			{ base: 0x400000, len: 8 },
			1,
			0,
		),
	),
	procMem: attempt(() => {
		closeSync(openSync(`/proc/${pid}/mem`, "r"));
		return "OK";
	}),
	procEnviron: attempt(() => {
		closeSync(openSync(`/proc/${pid}/environ`, "r"));
		return "OK";
	}),
	procFdList: attempt(() => {
		readdirSync(`/proc/${pid}/fd`);
		return "OK";
	}),
	pidfdGetfd: attempt(() => {
		const pidfd = Number(
			syscall(SYS_PIDFD_OPEN, "int", pid, "unsigned int", 0),
		);
		if (pidfd < 0) return `PIDFD_OPEN_${names.get(koffi.errno())}`;
		const duplicate = Number(
			syscall(SYS_PIDFD_GETFD, "int", pidfd, "int", 0, "unsigned int", 0),
		);
		const code = duplicate < 0 ? names.get(koffi.errno()) : "OK";
		if (duplicate >= 0) closeSync(duplicate);
		closeSync(pidfd);
		return code;
	}),
};
child.kill("SIGKILL");
process.stdout.write(
	`${JSON.stringify({ dumpable: Number(dumpable), report })}\n`,
);
