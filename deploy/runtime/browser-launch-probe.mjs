import { probeChromiumLaunchV1 } from "@agent-infra/agent-runtime";

// This network-free image supply check never returns capability available or
// certifies Session sandbox/security, Host/Driver invocation or conformance.
try {
	console.log(JSON.stringify(await probeChromiumLaunchV1()));
} catch (error) {
	process.exitCode = 1;
	if (error instanceof Error) {
		const cause = error.cause;
		const causeText =
			cause instanceof Error ? cause.stack ?? cause.message : String(cause ?? "");
		console.error(`${error.stack ?? error.message}${causeText ? `\nCaused by: ${causeText}` : ""}`);
	} else {
		console.error(error);
	}
}
