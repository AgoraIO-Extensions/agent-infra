import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseNativeSandbox } from "../deploy/runtime/native-sandbox-preflight.mjs";

const fake = (responses) => (binary, args) => {
	const key = `${binary} ${args.join(" ")}`;
	return responses[key] ?? { status: 0, stdout: "", stderr: "" };
};

test("native sandbox validator classifies bwrap namespace permission failures", () => {
	const spawn = fake({
		"bwrap --version": { status: 0, stdout: "bubblewrap 0.9.0" },
		"bwrap --unshare-user --unshare-pid --unshare-net --die-with-parent --ro-bind / / --proc /proc --dev /dev /bin/true":
			{
				status: 1,
				stderr: "bwrap: No permissions to create new namespace",
			},
	});
	assert.deepEqual(diagnoseNativeSandbox({ platform: "linux", spawn }), {
		status: "failed",
		code: "NATIVE_SANDBOX_BWRAP_NAMESPACE_DENIED",
		binary: "bwrap",
		exitCode: 1,
		stderrClass: "namespace-permission",
	});
});

test("native sandbox validator requires both bwrap and Landlock probes", () => {
	const spawn = fake({
		"bwrap --version": { status: 0, stdout: "bubblewrap 0.9.0" },
		"bwrap --unshare-user --unshare-pid --unshare-net --die-with-parent --ro-bind / / --proc /proc --dev /dev /bin/true":
			{ status: 0 },
		"setpriv --no-new-privs --landlock-access fs:ioctl-dev -- /bin/true": {
			status: 1,
		},
	});
	assert.deepEqual(diagnoseNativeSandbox({ platform: "linux", spawn }), {
		status: "failed",
		code: "NATIVE_SANDBOX_LANDLOCK_UNAVAILABLE",
		binary: "setpriv",
		exitCode: 1,
	});
});

test("non-Linux hosts are reported as unavailable instead of passed", () => {
	assert.deepEqual(diagnoseNativeSandbox({ platform: "darwin" }), {
		status: "unavailable",
		code: "NATIVE_SANDBOX_LINUX_REQUIRED",
	});
});
