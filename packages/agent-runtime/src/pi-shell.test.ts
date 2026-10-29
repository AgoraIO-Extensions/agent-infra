import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import * as admission from "./native-shell-admission.js";
import {
	createPiNativeShellTool,
	piNativeShellAvailable,
	piNativeShellToolName,
} from "./pi-shell.js";
import { piToolId, piWorkspaceToolNames } from "./pi-tools.js";

it.each(["runtime-root", "unadmitted-shell"] as const)(
	"loads %s without resolving the Pi SDK",
	async (entry) => {
		const runtime = new URL("../dist/index.mjs", import.meta.url);
		await access(runtime);
		const { stdout } = await promisify(execFile)(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@earendil-works/pi-coding-agent" ||
			specifier.startsWith("@earendil-works/pi-coding-agent/"))
			throw new Error("UNEXPECTED_EAGER_PI_SDK");
		if (specifier.startsWith(".") && specifier.endsWith(".js") &&
			context.parentURL?.startsWith(${JSON.stringify(new URL("./", import.meta.url).href)}))
			return nextResolve(specifier.slice(0, -3) + ".ts", context);
		return nextResolve(specifier, context);
	}
});
if (${JSON.stringify(entry)} === "runtime-root") {
	await import(${JSON.stringify(runtime.href)});
} else {
	const { createPiNativeShellTool } = await import(${JSON.stringify(new URL("./pi-shell.ts", import.meta.url).href)});
	assert.equal(await createPiNativeShellTool("/missing/session/workspace"), undefined);
}
console.log("loaded-without-pi-sdk");
`,
			],
			{ timeout: 30_000 },
		);
		expect(stdout.trim()).toBe("loaded-without-pi-sdk");
	},
);

it("cannot advertise unwrapped builtin Bash as a fallback", async () => {
	expect(piWorkspaceToolNames).not.toContain("bash");
	expect(piNativeShellToolName).not.toBe("bash");
	expect(piToolId(piNativeShellToolName)).toBe("Bash");
	expect(await piNativeShellAvailable("/missing/session/workspace")).toBe(
		false,
	);
	expect(
		await createPiNativeShellTool("/missing/session/workspace"),
	).toBeUndefined();
});

it("creates the original Pi tool only after native shell admission", async () => {
	const available = vi
		.spyOn(admission, "nativeShellAvailable")
		.mockResolvedValue(true);
	try {
		const tool = await createPiNativeShellTool("/session/workspace");
		expect(tool?.name).toBe(piNativeShellToolName);
		expect(tool?.execute).toBeTypeOf("function");
		expect(tool?.parameters).toHaveProperty("properties.command");
		expect(available).toHaveBeenCalledExactlyOnceWith("/session/workspace");
	} finally {
		available.mockRestore();
	}
});

it("rejects a previously advertised Pi tool when launcher admission is lost", async () => {
	const available = vi
		.spyOn(admission, "nativeShellAvailable")
		.mockResolvedValueOnce(true)
		.mockResolvedValue(false);
	try {
		const tool = await createPiNativeShellTool("/session/workspace");
		expect(tool).toBeDefined();
		await expect(
			tool?.execute(
				"tool",
				{ command: "touch must-not-run" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("RUNTIME_NATIVE_SHELL_UNAVAILABLE");
		expect(available).toHaveBeenCalledTimes(2);
	} finally {
		available.mockRestore();
	}
});
