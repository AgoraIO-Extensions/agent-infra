import WebSocket from "ws";

/** Browser and SSH connections share the same Worker PTY and live authorization. */
export function attachMaintenanceTerminal(input: {
	connect: () => WebSocket;
	authorized: () => Promise<boolean>;
	output: (data: Buffer, binary: boolean) => void;
	close: (code: number) => void;
}) {
	let closed = false;
	let pending = 0;
	let checking: Promise<boolean> | undefined;
	const peer = input.connect();
	const stop = (code: number) => {
		if (closed) return;
		closed = true;
		clearInterval(heartbeat);
		peer.terminate();
		input.close(code);
	};
	const allowed = () => {
		if (!checking) {
			const deadline = setTimeout(() => stop(1011), 5_000);
			checking = Promise.resolve()
				.then(input.authorized)
				.catch(() => false)
				.finally(() => {
					clearTimeout(deadline);
					checking = undefined;
				});
		}
		return checking;
	};
	async function forward(size: number, action: () => void) {
		if (closed) return;
		pending += size + 64;
		if (pending > 262144) {
			stop(1013);
			return;
		}
		try {
			if (!(await allowed())) {
				stop(1008);
				return;
			}
			if (!closed) action();
		} catch {
			stop(1011);
		} finally {
			pending -= size + 64;
		}
	}
	const heartbeat = setInterval(
		() =>
			void allowed().then((ok) => {
				if (!ok) stop(1008);
			}),
		1000,
	);
	peer.on("message", (data, binary) => {
		const bytes = Array.isArray(data)
			? Buffer.concat(data)
			: Buffer.isBuffer(data)
				? data
				: Buffer.from(data);
		void forward(bytes.length, () => input.output(bytes, binary));
	});
	peer.on("error", () => stop(1011));
	peer.on("close", (code) =>
		stop(code === 1000 || code === 1005 ? 1000 : 1011),
	);
	return {
		send(data: string | Uint8Array | ArrayBuffer) {
			const size =
				typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
			if (size > 32_768) {
				stop(1009);
				return;
			}
			void forward(size, () => {
				if (
					peer.readyState !== WebSocket.OPEN ||
					peer.bufferedAmount > 262144
				) {
					stop(1013);
					return;
				}
				peer.send(data, { binary: typeof data !== "string" });
			});
		},
		close: () => stop(1000),
	};
}
