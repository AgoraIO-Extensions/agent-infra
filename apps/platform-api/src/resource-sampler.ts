import type { startObservability } from "@agent-infra/observability";
import type { PlatformApiAssembly } from "./assembly.js";

/** Process-owned sampling of the existing query; no business state is computed here. */
export function startPlatformResourceSampling(
	read: PlatformApiAssembly["readResourceSnapshot"],
	observability: ReturnType<typeof startObservability>,
	intervalMs: number,
) {
	let stopped = false;
	let scheduled: ReturnType<typeof setTimeout> | undefined;
	let active: AbortController | undefined;
	let pending: Promise<void> | undefined;
	let stopping: Promise<void> | undefined;

	async function sample() {
		const controller = new AbortController();
		active = controller;
		const deadline = setTimeout(() => controller.abort(), 2000);
		deadline.unref();
		try {
			const snapshot = await read(controller.signal);
			if (stopped) return;
			if (controller.signal.aborted)
				throw new Error("Platform resource snapshot is unavailable");
			if (
				!Number.isSafeInteger(snapshot.taskWaiting) ||
				snapshot.taskWaiting < 0 ||
				!Number.isSafeInteger(snapshot.outboxPending) ||
				snapshot.outboxPending < 0
			)
				throw new Error("Platform resource snapshot is unavailable");
			observability.observeResource({
				kind: "task_waiting",
				value: snapshot.taskWaiting,
			});
			observability.observeResource({
				kind: "outbox_pending",
				value: snapshot.outboxPending,
			});
		} catch {
			if (!stopped) {
				try {
					observability.record({
						stage: "dependency",
						outcome: "failed",
						code: "DEPENDENCY_UNAVAILABLE",
					});
				} catch {
					// Telemetry capture must not escape the background sampler.
				}
			}
		} finally {
			clearTimeout(deadline);
			active = undefined;
			if (!stopped) {
				scheduled = setTimeout(run, intervalMs);
				scheduled.unref();
			}
		}
	}

	function run() {
		pending = sample();
	}

	run();
	return {
		stop() {
			stopping ??= (async () => {
				stopped = true;
				clearTimeout(scheduled);
				active?.abort();
				let deadline: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						pending,
						new Promise<void>((resolve) => {
							deadline = setTimeout(resolve, 2000);
						}),
					]);
				} finally {
					clearTimeout(deadline);
				}
			})();
			return stopping;
		},
	};
}
