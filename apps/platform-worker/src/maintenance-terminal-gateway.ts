import { timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import { PassThrough, Writable } from "node:stream";
import { Exec, KubeConfig, type V1Pod } from "@kubernetes/client-node";
import WebSocket, { WebSocketServer } from "ws";
import { createWorkerKubernetesClientV1 } from "./kubernetes-client.js";
import {
	type MaintenanceWorkloadOptions,
	prepareMaintenancePod,
} from "./maintenance-terminal-workload.js";

export type MaintenancePodSettings = Omit<
	MaintenanceWorkloadOptions,
	"directoryId"
>;
export type AttachMaintenancePty = (
	directoryId: string,
	socket: WebSocket,
	signal: AbortSignal,
) => Promise<void>;

export function createMaintenancePty(
	settings: MaintenancePodSettings,
	current: (directoryId: string, activate?: boolean) => Promise<boolean>,
	closeStore: () => Promise<void>,
) {
	const config = new KubeConfig();
	config.loadFromCluster();
	const client = createWorkerKubernetesClientV1(settings.namespace, config);
	async function retire(pod: V1Pod) {
		const id =
			pod.metadata?.labels?.["agent-infra.agora.io/maintenance-directory"];
		if (
			!id ||
			pod.metadata?.name !== `maint-${id}` ||
			pod.metadata?.namespace !== settings.namespace ||
			pod.metadata.deletionTimestamp ||
			pod.metadata.ownerReferences?.length ||
			pod.metadata.labels?.["app.kubernetes.io/instance"] !==
				(settings.release ?? "agent-infra") ||
			pod.metadata.labels?.["app.kubernetes.io/component"] !==
				"agent-maintenance"
		)
			return;
		if (!(await current(id))) await client.delete(pod);
	}
	let sweeping: Promise<void> | undefined;
	const sweep = () => {
		if (!sweeping)
			sweeping = client
				.list<V1Pod>(
					"Pod",
					`app.kubernetes.io/component=agent-maintenance,app.kubernetes.io/instance=${settings.release ?? "agent-infra"}`,
				)
				.then(async (pods) => {
					await Promise.allSettled(pods.map(retire));
				})
				.catch(() => undefined)
				.finally(() => {
					sweeping = undefined;
				});
	};
	const sweepTimer = setInterval(sweep, 3000);
	sweep();
	const attach: AttachMaintenancePty = async (directoryId, socket, signal) => {
		if (!(await current(directoryId)))
			throw new Error("Maintenance directory unavailable");
		const pod = await prepareMaintenancePod(
			client,
			{ ...settings, directoryId },
			AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
		);
		signal.throwIfAborted();
		// Only a policy close from the authenticated API revokes the detached shell.
		socket.once("close", (code) => {
			if (code === 1008) void retire(pod).catch(() => undefined);
		});
		if (!(await current(directoryId, true)))
			throw new Error("Maintenance authority expired");
		const input = new PassThrough({ highWaterMark: 65_536 });
		const output = Object.assign(
			new Writable({
				write(chunk, _encoding, done) {
					if (
						socket.readyState !== WebSocket.OPEN ||
						socket.bufferedAmount > 262_144
					) {
						socket.terminate();
						done();
						return;
					}
					socket.send(chunk, { binary: true }, (error) => {
						if (error) socket.terminate();
					});
					done();
				},
			}),
			{ columns: 80, rows: 24 },
		);
		const name = pod.metadata?.name;
		if (!name) throw new Error("Missing maintenance Pod identity");
		const remote = await new Exec(config).exec(
			settings.namespace,
			name,
			"maintenance",
			[
				"tmux",
				"-u",
				"-L",
				"maintenance",
				"-f",
				"/dev/null",
				"new-session",
				"-A",
				"-s",
				"deployment",
				"-c",
				"/deployment",
			],
			output,
			null,
			input,
			true,
			() => socket.close(),
		);
		const close = () => {
			remote.terminate();
			input.destroy();
			output.destroy();
		};
		if (signal.aborted) {
			close();
			return;
		}
		signal.addEventListener("abort", close, { once: true });
		remote.on("error", () => socket.close(1011));
		remote.on("close", () => {
			signal.removeEventListener("abort", close);
			input.destroy();
			output.destroy();
			socket.close();
		});
		socket.on("message", (data, binary) => {
			if (binary) {
				if (remote.bufferedAmount > 262_144 || !input.write(data))
					socket.close(1013);
				return;
			}
			try {
				const size = JSON.parse(data.toString());
				if (
					!Number.isInteger(size.cols) ||
					size.cols < 2 ||
					size.cols > 500 ||
					!Number.isInteger(size.rows) ||
					size.rows < 1 ||
					size.rows > 200
				)
					throw new Error();
				output.columns = size.cols;
				output.rows = size.rows;
				output.emit("resize");
			} catch {
				socket.close(1008);
			}
		});
		socket.send("ready");
	};
	return {
		attach,
		async close() {
			clearInterval(sweepTimer);
			await sweeping;
			await closeStore();
		},
	};
}

// This route has its own API-to-Worker credential. It accepts only a DB-issued directory UUID.
export function registerMaintenanceGateway(
	server: Server,
	serviceToken: string,
	attach: AttachMaintenancePty,
) {
	if (!/^[\x21-\x7e]{32,512}$/.test(serviceToken))
		throw new Error("Invalid maintenance transport credential");
	const expected = Buffer.from(`Bearer ${serviceToken}`);
	const wss = new WebSocketServer({
		noServer: true,
		perMessageDeflate: false,
		maxPayload: 32_768,
	});
	server.on("upgrade", (request, socket, head) => {
		const match =
			/^\/internal\/worker\/v1\/maintenance-terminal\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.exec(
				request.url ?? "",
			);
		const supplied = Buffer.from(request.headers.authorization ?? "");
		if (
			!match?.[1] ||
			supplied.length !== expected.length ||
			!timingSafeEqual(supplied, expected) ||
			request.headers.origin
		) {
			socket.destroy();
			return;
		}
		const directory = match[1];
		wss.handleUpgrade(request, socket, head, (ws) => {
			const cancel = new AbortController();
			ws.on("error", () => ws.terminate());
			ws.once("close", () => cancel.abort());
			void attach(directory, ws, cancel.signal).catch(() => ws.close(1011));
		});
	});
	return () => {
		for (const socket of wss.clients) socket.terminate();
		wss.close();
	};
}
