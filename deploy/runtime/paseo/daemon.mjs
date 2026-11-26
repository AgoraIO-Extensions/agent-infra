import { createInterface } from "node:readline";
import {
	createPaseoDaemon,
	createRootLogger,
	hashDaemonPassword,
} from "@getpaseo/server";
import { privateDaemonConfig } from "./config.mjs";

// Closing the Host pipe also shuts down the daemon after an ungraceful Host exit.
delete process.env.AGENT_INFRA_PASEO_OWNER;
const lines = createInterface({ input: process.stdin });
const input = lines[Symbol.asyncIterator]();
try {
	const first = await input.next();
	if (first.done) throw new Error();
	const { password, ...binding } = JSON.parse(first.value);
	const config = privateDaemonConfig({
		...binding,
		passwordHash: hashDaemonPassword(password),
	});
	const logger = createRootLogger(
		{ log: { level: "silent" } },
		{ paseoHome: binding.home, file: false },
	);
	const daemon = await createPaseoDaemon(config, logger, {
		lazyTerminalWorker: true,
		// Paseo 0.17.4 loads built-ins even with pluginsEnabled disabled. The
		// OpenCode sandbox gets its sole provider from the Generic ACP override.
		...(binding.provider === "agent-infra-opencode"
			? { builtinPlugins: { ids: new Set(), async load() {} } }
			: {}),
	});
	await daemon.start();
	process.stdout.write("AGENT_INFRA_PASEO_READY\n");
	await input.next();
	await daemon.stop({ keepTerminals: false });
	process.exit(0);
} catch {
	process.exit(1);
}
