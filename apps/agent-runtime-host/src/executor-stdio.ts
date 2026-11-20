import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { CODEX_PILOT_EXECUTABLE } from "@agent-infra/agent-runtime";

// Run under the fixed exec-server's own launch path, with the same UID and
// ancestry as ordinary tools. Opens only check access. Nothing is read from
// the parent's memory or written to the parent's channels.
const launchIsolationProbe = String.raw`
	const fs = require("node:fs");
	const parent = Number(process.argv[1]);
	const uid = Number(process.argv[2]);
	const proc = "/proc/" + parent;
	if (process.ppid !== parent || uid <= 0 || process.getuid() !== uid ||
		process.geteuid() !== uid ||
		!["1", "2", "3"].includes(fs.readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim()))
		process.exit(1);
	const parentStatus = fs.readFileSync(proc + "/status", "utf8");
	if (!parentStatus.split("\n").some((line) =>
		line.startsWith("Uid:") && line.trim().split(/\s+/).slice(1).every((value) => Number(value) === uid)))
		process.exit(1);
	const channels = ["0", "1"].map((fd) => fs.readlinkSync(proc + "/fd/" + fd));
	if (!channels.every((channel) => /^socket:\[\d+\]$/.test(channel)))
		process.exit(1);
	for (const fd of fs.readdirSync("/proc/self/fd")) {
		try {
			if (channels.includes(fs.readlinkSync("/proc/self/fd/" + fd))) process.exit(1);
		} catch (error) {
			if (error.code !== "ENOENT") process.exit(1);
		}
	}
	for (const [path, modes] of [
		[proc + "/mem", [fs.constants.O_RDONLY, fs.constants.O_RDWR]],
		[proc + "/fd/0", [fs.constants.O_RDONLY, fs.constants.O_WRONLY]],
		[proc + "/fd/1", [fs.constants.O_RDONLY, fs.constants.O_WRONLY]],
	]) {
		for (const mode of modes) {
			try {
				fs.closeSync(fs.openSync(path, mode));
				process.exit(1);
			} catch (error) {
				if (!["EPERM", "EACCES"].includes(error.code) &&
					!(path.includes("/fd/") && error.code === "ENXIO")) process.exit(1);
			}
		}
	}
`;

export function openPrivateExecutorV1(cwd: string, home: string) {
	const child = spawn(
		CODEX_PILOT_EXECUTABLE,
		["exec-server", "--listen", "stdio"],
		{
			cwd,
			env: {
				PATH: "/opt/codex/bin:/usr/local/bin:/usr/bin:/bin",
				HOME: home,
				CODEX_HOME: home,
				TMPDIR: "/tmp",
			},
			stdio: ["pipe", "pipe", "ignore"],
		},
	);
	const pending = new Map<
		number,
		(response: Record<string, unknown>) => void
	>();
	let sequence = 0;
	let closed = false;
	const lines = createInterface({ input: child.stdout });
	const write = (frame: unknown) => {
		if (closed || child.stdin.writableLength > 64 * 1024 * 1024) {
			close();
			throw new Error("CODEX_EXECUTOR_TRANSPORT_UNAVAILABLE");
		}
		child.stdin.write(`${JSON.stringify(frame)}\n`);
	};
	const close = () => {
		if (closed) return;
		closed = true;
		lines.close();
		child.stdin.end();
		for (const handle of pending.values()) handle({ error: { code: -32000 } });
		pending.clear();
		child.kill();
	};
	const notifications = new Set<(frame: Record<string, unknown>) => void>();
	lines.on("line", (line) => {
		if (line.length > 64 * 1024 * 1024) {
			close();
			return;
		}
		try {
			const frame = JSON.parse(line) as Record<string, unknown>;
			if (typeof frame.id === "number") pending.get(frame.id)?.(frame);
			else for (const listener of notifications) listener(frame);
		} catch {
			close();
		}
	});
	child.once("error", close);
	child.once("exit", close);
	child.stdin.once("error", close);
	function request(method: string, params: unknown, timeoutMs = 2_000) {
		const id = ++sequence;
		return new Promise<Record<string, unknown>>((resolve, reject) => {
			const timeout = setTimeout(() => {
				pending.delete(id);
				reject(new Error("CODEX_EXECUTOR_TRANSPORT_UNAVAILABLE"));
			}, timeoutMs);
			pending.set(id, (response) => {
				clearTimeout(timeout);
				pending.delete(id);
				resolve(response);
			});
			try {
				write({ id, method, params });
			} catch (error) {
				clearTimeout(timeout);
				pending.delete(id);
				reject(error);
			}
		});
	}
	let isolation: Promise<void> | undefined;
	function requireLaunchIsolation() {
		isolation ??= (async () => {
			try {
				const uid = process.getuid?.();
				if (
					process.platform !== "linux" ||
					uid === undefined ||
					uid <= 0 ||
					!child.pid
				)
					throw new Error();
				const processId = `isolation-${randomUUID()}`;
				const started = await request("process/start", {
					processId,
					argv: [
						"/usr/local/bin/node",
						"-e",
						launchIsolationProbe,
						String(child.pid),
						String(uid),
					],
					cwd: pathToFileURL(cwd).href,
					env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
					tty: false,
					pipeStdin: false,
					arg0: null,
					sandbox: null,
					enforceManagedNetwork: false,
				});
				if (started.error) throw new Error();
				const deadline = Date.now() + 2000;
				while (true) {
					const remaining = deadline - Date.now();
					if (remaining <= 0) throw new Error();
					const exited = await request(
						"process/read",
						{
							processId,
							afterSeq: 0,
							maxBytes: 1024,
							waitMs: Math.min(1000, remaining),
						},
						remaining,
					);
					const result = exited.result as
						| {
								exited?: boolean;
								closed?: boolean;
								exitCode?: number;
								failure?: unknown;
								sandboxDenied?: boolean;
						  }
						| undefined;
					if (
						exited.error ||
						!result ||
						result.failure ||
						result.sandboxDenied ||
						(result.exited && result.exitCode !== 0)
					)
						throw new Error();
					if (result.exited && result.closed) break;
					// Exit and pipe closure are separate native observations of the same probe.
					await new Promise<void>((resolve) => setTimeout(resolve, 5));
				}
			} catch {
				close();
				throw new Error("CODEX_EXECUTOR_LAUNCH_NOT_ISOLATED");
			}
		})();
		return isolation;
	}

	return {
		get pid() {
			return child.pid;
		},
		async initialize() {
			const response = await request("initialize", {
				clientName: "agent-infra-executor",
				resumeSessionId: null,
			});
			if (response.error || !response.result) {
				close();
				throw new Error("CODEX_EXECUTOR_TRANSPORT_UNAVAILABLE");
			}
			write({ method: "initialized", params: {} });
		},
		requireLaunchIsolation,
		request,
		notification(method: string, params: unknown) {
			write({ method, params });
		},
		notifications,
		close,
	};
}
