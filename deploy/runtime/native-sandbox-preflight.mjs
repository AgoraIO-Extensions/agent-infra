#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const defaultBwrap = process.env.BWRAP_BIN ?? "bwrap";
const defaultSetpriv = process.env.SETPRIV_BIN ?? "setpriv";

const failure = (code, details = {}) => ({
	status: "failed",
	code,
	...details,
});

function run(binary, args, spawn = spawnSync) {
	try {
		const result = spawn(binary, args, {
			encoding: "utf8",
			timeout: 10_000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return {
			status: result.status,
			error: result.error,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
		};
	} catch (error) {
		return { status: null, error, stdout: "", stderr: "" };
	}
}

/**
 * Diagnose the immutable Runtime sandbox prerequisites without changing the host.
 * A passing bwrap probe is only a prerequisite; it does not prove a full Agent turn.
 */
export function diagnoseNativeSandbox({
	platform = process.platform,
	bwrap = defaultBwrap,
	setpriv = defaultSetpriv,
	spawn = spawnSync,
} = {}) {
	if (platform !== "linux")
		return { status: "unavailable", code: "NATIVE_SANDBOX_LINUX_REQUIRED" };

	const bwrapVersion = run(bwrap, ["--version"], spawn);
	if (bwrapVersion.error?.code === "ENOENT")
		return failure("NATIVE_SANDBOX_BWRAP_MISSING", { binary: bwrap });
	if (bwrapVersion.status !== 0)
		return failure("NATIVE_SANDBOX_BWRAP_VERSION_FAILED", {
			binary: bwrap,
			exitCode: bwrapVersion.status,
		});

	const namespaceProbe = run(
		bwrap,
		[
			"--unshare-user",
			"--unshare-pid",
			"--unshare-net",
			"--die-with-parent",
			"--ro-bind",
			"/",
			"/",
			"--proc",
			"/proc",
			"--dev",
			"/dev",
			"/bin/true",
		],
		spawn,
	);
	if (namespaceProbe.status !== 0) {
		const text = `${namespaceProbe.error?.message ?? ""}\n${namespaceProbe.stderr}`;
		const denied = /permission|operation not permitted|unshare|namespace|EPERM/i.test(text);
		return failure(
			denied
				? "NATIVE_SANDBOX_BWRAP_NAMESPACE_DENIED"
				: "NATIVE_SANDBOX_BWRAP_PROBE_FAILED",
			{
				binary: bwrap,
				exitCode: namespaceProbe.status,
				stderrClass: denied ? "namespace-permission" : "other",
			},
		);
	}

	const landlockProbe = run(
		setpriv,
		["--no-new-privs", "--landlock-access", "fs:ioctl-dev", "--", "/bin/true"],
		spawn,
	);
	if (landlockProbe.error?.code === "ENOENT")
		return failure("NATIVE_SANDBOX_SETPRIV_MISSING", { binary: setpriv });
	if (landlockProbe.status !== 0)
		return failure("NATIVE_SANDBOX_LANDLOCK_UNAVAILABLE", {
			binary: setpriv,
			exitCode: landlockProbe.status,
		});

	return {
		status: "passed",
		code: "NATIVE_SANDBOX_PREREQUISITES_READY",
		bwrap,
		setpriv,
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const result = diagnoseNativeSandbox();
	process.stdout.write(`${JSON.stringify(result)}\n`);
	if (result.status !== "passed") process.exitCode = 1;
}
