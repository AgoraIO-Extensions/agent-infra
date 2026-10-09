import { probeChromiumLaunchV1 } from "@agent-infra/agent-runtime";

// This network-free image supply check never returns capability available or
// certifies Session sandbox/security, Host/Driver invocation or conformance.
try {
	console.log(JSON.stringify(await probeChromiumLaunchV1()));
} catch {
	process.exitCode = 1;
	console.error("RUNTIME_BROWSER_LAUNCH_PROBE_FAILED");
}
