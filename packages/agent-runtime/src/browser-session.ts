import type { BrowserCapabilityAvailableV1 } from "@agent-infra/contracts/runtime";
import type { BrowserContext } from "playwright-core";
import {
	type BrowserContextBindingV1,
	type BrowserContextManagerSnapshotV1,
	type BrowserContextManagerV1,
	createChromiumBrowserContextManagerV1,
} from "./browser-context.js";
import type {
	BrowserObservationV1,
	BrowserPageReferenceV1,
} from "./browser-observe.js";
import { createBrowserObserveControllerV1 } from "./browser-observe.js";

export type BrowserSessionControllerV1 = Readonly<{
	start(): Promise<BrowserContext>;
	navigate(url: string): Promise<BrowserPageReferenceV1>;
	observe(reference: BrowserPageReferenceV1): Promise<BrowserObservationV1>;
	close(): Promise<void>;
	snapshot(): BrowserContextManagerSnapshotV1;
}>;

export function createBrowserSessionControllerV1(input: {
	readonly manager: BrowserContextManagerV1;
	readonly binding: BrowserContextBindingV1;
	readonly capability: BrowserCapabilityAvailableV1;
}): BrowserSessionControllerV1 {
	let observe: ReturnType<typeof createBrowserObserveControllerV1> | undefined;

	async function start(): Promise<BrowserContext> {
		const context = await input.manager.acquire(
			input.binding,
			input.capability,
		);
		observe ??= createBrowserObserveControllerV1({
			context,
			capability: input.capability,
		});
		return context;
	}

	return {
		start,
		async navigate(url) {
			await start();
			const controller = observe;
			if (!controller) throw new Error("BROWSER_SESSION_UNAVAILABLE");
			return controller.navigate(url);
		},
		async observe(reference) {
			await start();
			const controller = observe;
			if (!controller) throw new Error("BROWSER_SESSION_UNAVAILABLE");
			return controller.observe(reference);
		},
		async close() {
			await input.manager.close(input.binding);
			observe = undefined;
		},
		snapshot: input.manager.snapshot,
	};
}

export function createChromiumBrowserSessionControllerV1(input: {
	readonly sandboxRoot: string;
	readonly binding: BrowserContextBindingV1;
	readonly capability: BrowserCapabilityAvailableV1;
}): BrowserSessionControllerV1 {
	return createBrowserSessionControllerV1({
		...input,
		manager: createChromiumBrowserContextManagerV1({
			sandboxRoot: input.sandboxRoot,
		}),
	});
}
