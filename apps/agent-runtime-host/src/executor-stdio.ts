import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { CODEX_PILOT_EXECUTABLE } from "@agent-infra/agent-runtime";

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
		request,
		notification(method: string, params: unknown) {
			write({ method, params });
		},
		notifications,
		close,
	};
}
