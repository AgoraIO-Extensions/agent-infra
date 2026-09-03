import type {
	CodexAppServerBridgeOptions,
	CodexAppServerFrame,
} from "./codex-app-server-bridge.js";
import {
	CodexRuntimeDriver,
	type CodexRuntimeDriverOptions,
} from "./codex-runtime-driver.js";

interface TestCodexAppServerTransport {
	send(frame: CodexAppServerFrame): Promise<void>;
	frames(): AsyncIterable<CodexAppServerFrame>;
	close?(): Promise<void>;
}

type OpenTestCodexBridge = (
	options: CodexAppServerBridgeOptions,
) => Promise<TestCodexAppServerTransport>;

class CodexRuntimeDriverTestAccess extends CodexRuntimeDriver {
	static openForTest(
		options: CodexRuntimeDriverOptions,
		openBridge: OpenTestCodexBridge,
	) {
		return CodexRuntimeDriverTestAccess.openWithBridge(options, openBridge);
	}
}

/** @internal Test-only source helper. It is intentionally absent from the package barrel. */
export function openCodexRuntimeDriverForTest(
	options: CodexRuntimeDriverOptions,
	openBridge: OpenTestCodexBridge,
) {
	return CodexRuntimeDriverTestAccess.openForTest(options, openBridge);
}
