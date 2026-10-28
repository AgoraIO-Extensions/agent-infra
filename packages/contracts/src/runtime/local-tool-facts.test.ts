import { expect, it } from "vitest";
import { RuntimeOperationFactV2Schema } from "./events-v2.ts";

const local = {
	kind: "tool",
	toolId: "Bash",
	operationRef: "local",
	attemptRef: "attempt",
	phase: "started",
	executionBoundary: "sandbox-local",
};
it("permits only non-mediated native observations to carry the local boundary", () => {
	expect(RuntimeOperationFactV2Schema.parse(local)).toEqual(local);
	for (const patch of [
		{ phase: "intent" },
		{ toolId: "mcp.connection" },
		{ toolId: "browser.click" },
		{ toolId: "workspace.publish_result_file" },
		{ rpcRequestId: "rpc" },
		{ requestDigest: "a".repeat(64) },
		{ connection: {} },
		{ browser: {} },
		{ executionBoundary: "caller" },
	])
		expect(
			RuntimeOperationFactV2Schema.safeParse({ ...local, ...patch }).success,
		).toBe(false);
	const { executionBoundary: _boundary, ...old } = local;
	expect(
		RuntimeOperationFactV2Schema.parse({ ...old, phase: "intent" }),
	).toMatchObject({ phase: "intent" });
});
