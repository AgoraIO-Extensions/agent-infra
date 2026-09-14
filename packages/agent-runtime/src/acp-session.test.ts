import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { openAcpSession } from "./acp-session.js";

it("discovers grouped native models, reads the current choice, and rejects choices removed by the peer", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "acp-models-"));
	await mkdir(join(cwd, "workspace"));
	const session = await openAcpSession({
		directory: cwd,
		cwd: join(cwd, "workspace"),
		launch: {
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "grouped-models" },
		},
		update: async () => {},
	});
	try {
		expect(session.modelSelection()).toMatchObject({
			models: ["provider/model", "provider/other"],
			currentModel: "provider/model",
			reasoningLevels: ["high"],
		});
		await session.select("provider/other", "high");
		expect(session.modelSelection()).toMatchObject({
			models: ["provider/other"],
			currentModel: "provider/other",
			currentReasoning: "high",
		});
		await expect(session.select("provider/model", "high")).rejects.toThrow(
			"RUNTIME_MODEL_SELECTION_UNSUPPORTED",
		);
	} finally {
		await session.close();
		await rm(cwd, { recursive: true, force: true });
	}
});
