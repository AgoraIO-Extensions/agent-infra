import type { BrowserCapabilityAvailableV1 } from "@agent-infra/contracts/runtime";
import type { BrowserContext } from "playwright-core";
import {
	type BrowserContextBindingV1,
	type BrowserContextManagerSnapshotV1,
	type BrowserContextManagerV1,
	createChromiumBrowserContextManagerV1,
} from "./browser-context.js";
import type {
	BrowserActionRecordV1,
	BrowserActionRequestV1,
	BrowserControlledFixtureV1,
	BrowserObservationV1,
	BrowserPageReferenceV1,
} from "./browser-observe.js";
import { createBrowserObserveControllerV1 } from "./browser-observe.js";

export type BrowserSessionControllerV1 = Readonly<{
	start(): Promise<BrowserContextManagerSnapshotV1>;
	navigate(url: string): Promise<BrowserPageReferenceV1>;
	observe(reference: BrowserPageReferenceV1): Promise<BrowserObservationV1>;
	act(request: BrowserActionRequestV1): Promise<BrowserActionRecordV1>;
	close(): Promise<void>;
	snapshot(): BrowserContextManagerSnapshotV1;
}>;

export function createBrowserSessionControllerV1(input: {
	readonly manager: BrowserContextManagerV1;
	readonly binding: BrowserContextBindingV1;
	readonly capability: BrowserCapabilityAvailableV1;
	readonly controlledFixture?: BrowserControlledFixtureV1;
}): BrowserSessionControllerV1 {
	let observe: ReturnType<typeof createBrowserObserveControllerV1> | undefined;
	let activeContext: BrowserContext | undefined;

	async function start(): Promise<BrowserContextManagerSnapshotV1> {
		const context = await input.manager.acquire(
			input.binding,
			input.capability,
		);
		if (activeContext !== context) {
			observe = createBrowserObserveControllerV1({
				context,
				capability: input.capability,
				controlledFixture: input.controlledFixture,
			});
			activeContext = context;
		}
		return input.manager.snapshot();
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
		async act(request) {
			await start();
			const controller = observe;
			if (!controller) throw new Error("BROWSER_SESSION_UNAVAILABLE");
			return controller.executeAction(request);
		},
		async close() {
			await input.manager.close(input.binding);
			observe = undefined;
			activeContext = undefined;
		},
		snapshot: input.manager.snapshot,
	};
}

export function createChromiumBrowserSessionControllerV1(input: {
	readonly sandboxRoot: string;
	readonly binding: BrowserContextBindingV1;
	readonly capability: BrowserCapabilityAvailableV1;
	readonly controlledFixture?: BrowserControlledFixtureV1;
}): BrowserSessionControllerV1 {
	return createBrowserSessionControllerV1({
		...input,
		manager: createChromiumBrowserContextManagerV1({
			sandboxRoot: input.sandboxRoot,
		}),
	});
}
