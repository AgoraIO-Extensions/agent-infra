import type { Page } from "@playwright/test";

/**
 * Keeps a controlled `/events` fixture open until the page aborts it. A body
 * that ends would leave the conversation timeline read-only.
 */
export async function keepConversationStreamOpen(page: Page) {
	await page.addInitScript(() => {
		const realFetch = window.fetch.bind(window);
		window.fetch = async (input, init) => {
			const request = new Request(input, init);
			const response = await realFetch(request);
			if (!new URL(request.url).pathname.endsWith("/events")) return response;
			void response.body?.cancel();
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
					const close = () => controller.close();
					if (request.signal.aborted) close();
					else request.signal.addEventListener("abort", close, { once: true });
				},
			});
			return new Response(body, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		};
	});
}
