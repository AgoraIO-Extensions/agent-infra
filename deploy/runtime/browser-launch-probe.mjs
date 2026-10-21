import { probeChromiumLaunchV1 } from "@agent-infra/agent-runtime";

// This network-free image supply check never returns capability available or
// certifies Session sandbox/security, Host/Driver invocation or conformance.
try {
	console.log(JSON.stringify(await probeChromiumLaunchV1()));
} catch (error) {
	process.exitCode = 1;
	console.error(error instanceof Error ? error.stack ?? error.message : error);
}
