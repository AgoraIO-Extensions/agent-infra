import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	checkAgentMaintenanceTerminalAccessV2,
	issueAgentMaintenanceSshV2,
} from "../../pilot/generated-v2/sdk.gen.js";

export function MaintenanceTerminal({ agentId }: { agentId: string }) {
	const [available, setAvailable] = useState<string | null>(null);
	const [sshAvailable, setSshAvailable] = useState(false);
	const [ssh, setSsh] = useState<{
		command: string;
		fingerprint: string;
		password: string;
		expiresAt: string;
	} | null>(null);
	const sshRequest = useRef<AbortController | null>(null);
	const [issuing, setIssuing] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const [status, setStatus] = useState("");
	const container = useRef<HTMLElement>(null);
	useEffect(() => {
		const abort = new AbortController();
		setAvailable(null);
		setSsh(null);
		setSshAvailable(false);
		setIssuing(false);
		setAttempt(0);
		setStatus("");
		void checkAgentMaintenanceTerminalAccessV2({
			path: { agentId },
			signal: abort.signal,
			responseStyle: "fields",
		})
			.then(({ response }) => {
				const modes =
					response?.headers.get("X-Maintenance-Terminal")?.split(",") ?? [];
				if (
					!abort.signal.aborted &&
					response?.status === 204 &&
					modes.includes("websocket")
				) {
					setAvailable(agentId);
					setSshAvailable(modes.includes("ssh"));
				}
			})
			.catch(() => {});
		return () => {
			abort.abort();
			sshRequest.current?.abort();
		};
	}, [agentId]);
	useEffect(() => {
		if (!attempt || available !== agentId || !container.current) return;
		const element = container.current;
		let disposed = false;
		let cleanup = () => {};
		setStatus("正在连接维护环境…");
		void Promise.all([
			import("@xterm/xterm"),
			import("@xterm/addon-fit"),
			import("@xterm/xterm/css/xterm.css"),
		])
			.then(([{ Terminal }, { FitAddon }]) => {
				if (disposed) return;
				const tty = new Terminal({ cursorBlink: true, screenReaderMode: true });
				const fit = new FitAddon();
				tty.loadAddon(fit);
				tty.open(element);
				fit.fit();
				const url = new URL(
					"/api/v2/agents/" +
						encodeURIComponent(agentId) +
						"/maintenance-terminal/socket",
					window.location.href,
				);
				url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
				const socket = new WebSocket(url);
				socket.binaryType = "arraybuffer";
				let ready = false;
				const resize = () => {
					fit.fit();
					if (ready && socket.readyState === WebSocket.OPEN)
						socket.send(
							JSON.stringify({
								cols: Math.min(500, Math.max(2, tty.cols)),
								rows: Math.min(200, Math.max(1, tty.rows)),
							}),
						);
				};
				const observer = new ResizeObserver(resize);
				observer.observe(element);
				const send = (bytes: Uint8Array) => {
					if (ready && socket.readyState === WebSocket.OPEN)
						for (let start = 0; start < bytes.length; start += 16_384)
							socket.send(bytes.slice(start, start + 16_384));
				};
				tty.onData((text) => send(new TextEncoder().encode(text)));
				tty.onBinary((text) =>
					send(Uint8Array.from(text, (c) => c.charCodeAt(0))),
				);
				socket.onmessage = (e) => {
					if (e.data === "ready") {
						ready = true;
						setStatus("已连接");
						resize();
						tty.focus();
					} else if (e.data instanceof ArrayBuffer)
						tty.write(new Uint8Array(e.data));
				};
				socket.onerror = () => {
					if (!disposed) setStatus("连接失败，可重新连接。");
				};
				socket.onclose = (e) => {
					ready = false;
					if (!disposed)
						setStatus(e.code === 1008 ? "维护权限已失效。" : "连接已断开。");
				};
				cleanup = () => {
					observer.disconnect();
					socket.onmessage = null;
					socket.onclose = null;
					socket.onerror = null;
					socket.close();
					tty.dispose();
				};
			})
			.catch(() => {
				if (!disposed) setStatus("终端加载失败，可重新连接。");
			});
		return () => {
			disposed = true;
			cleanup();
		};
	}, [agentId, available, attempt]);
	useEffect(() => {
		if (!ssh) return;
		const timer = setTimeout(
			() => setSsh(null),
			Math.max(0, Date.parse(ssh.expiresAt) - Date.now()),
		);
		return () => clearTimeout(timer);
	}, [ssh]);
	async function issueSsh() {
		sshRequest.current?.abort();
		const request = new AbortController();
		sshRequest.current = request;
		setIssuing(true);
		setSsh(null);
		try {
			const { data } = await issueAgentMaintenanceSshV2({
				signal: request.signal,
				path: { agentId },
				responseStyle: "fields",
				throwOnError: true,
			});
			if (!request.signal.aborted) setSsh(data);
		} catch {
			if (!request.signal.aborted) setStatus("获取 SSH 登录信息失败。");
		} finally {
			if (!request.signal.aborted) setIssuing(false);
		}
	}
	if (available !== agentId) return null;
	return (
		<section aria-label="部署维护终端" className="configuration-form-card">
			<div className="tag-row">
				{sshAvailable && (
					<Button
						type="button"
						onClick={() => void issueSsh()}
						disabled={issuing}
					>
						使用 SSH 连接
					</Button>
				)}
				<Button type="button" onClick={() => setAttempt(attempt + 1)}>
					{attempt ? "重新连接" : "打开维护终端"}
				</Button>
				{attempt > 0 && (
					<Button
						type="button"
						variant="ghost"
						onClick={() => {
							setAttempt(0);
							setStatus("");
						}}
					>
						断开
					</Button>
				)}
				<span role="status">{status}</span>
			</div>
			{ssh && (
				<div>
					<p>
						在本机运行 <code>{ssh.command}</code>
					</p>
					<p>
						主机指纹 <code>{ssh.fingerprint}</code>
					</p>
					<Label>
						一次性密码（两分钟内有效）{" "}
						<Input
							readOnly
							autoComplete="off"
							value={ssh.password}
							onFocus={(e) => e.target.select()}
						/>
					</Label>
					<Button type="button" variant="ghost" onClick={() => setSsh(null)}>
						隐藏
					</Button>
				</div>
			)}
			{attempt > 0 && (
				<section
					ref={container}
					aria-label="部署 Shell"
					style={{ height: "min(55vh, 32rem)", minHeight: "12rem" }}
				/>
			)}
		</section>
	);
}
