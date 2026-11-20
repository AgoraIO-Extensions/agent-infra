import { createRequire } from "node:module";

// Call prctl in the process that will hold the keys, before opening their files.
export function protectExecutorIdentityProcessV1(): void {
	if (process.platform === "linux" && process.getuid?.() !== 0) {
		const require = createRequire(import.meta.url);
		const koffi = require("koffi") as typeof import("koffi");
		const libc = koffi.load("libc.so.6");
		try {
			const prctl = libc.func("prctl", "int", [
				"int",
				"unsigned long",
				"unsigned long",
				"unsigned long",
				"unsigned long",
			]);
			const setDumpable = 4;
			const getDumpable = 3;
			if (
				prctl(setDumpable, 0, 0, 0, 0) === 0 &&
				prctl(getDumpable, 0, 0, 0, 0) === 0
			)
				return;
		} finally {
			libc.unload();
		}
	}
	throw new Error("CODEX_EXECUTOR_IDENTITY_PROCESS_UNPROTECTED");
}
