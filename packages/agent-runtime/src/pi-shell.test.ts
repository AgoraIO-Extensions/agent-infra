import { expect, it } from "vitest";
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
