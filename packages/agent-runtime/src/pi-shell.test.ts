import { expect, it, vi } from "vitest";
import * as admission from "./native-shell-admission.js";
import {
	createPiNativeShellTool,
	piNativeShellAvailable,
	piNativeShellToolName,
} from "./pi-shell.js";
import { piToolId, piWorkspaceToolNames } from "./pi-tools.js";

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
