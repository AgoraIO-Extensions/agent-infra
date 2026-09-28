import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const requireWebDependency = createRequire(
	new URL("../../apps/web/package.json", import.meta.url),
);
const { chromium, expect } = requireWebDependency("@playwright/test");

function digest(value) {
	return createHash("sha256").update(value).digest("hex");
}

async function privateFile(path) {
	assert(isAbsolute(path), "Browser state files must have absolute paths");
	const stat = await lstat(path);
	assert(
		stat.isFile() && (stat.mode & 0o077) === 0,
		"Browser state file must be private",
	);
	assert(
		process.getuid?.() === undefined || stat.uid === process.getuid(),
		"Browser state file must belong to the current user",
	);
}

function configuration(value) {
	assert(value && typeof value === "object" && !Array.isArray(value));
	const { origin, agentId, owner, other, prompt } = value;
	const url = new URL(origin);
	assert(
		(url.protocol === "https:" ||
			(url.protocol === "http:" && url.hostname === "127.0.0.1")) &&
			url.origin === origin &&
			!url.username &&
			!url.password,
		"Use an HTTPS origin or loopback HTTP origin",
	);
	for (const field of [agentId, prompt, owner?.userId, other?.userId])
		assert(typeof field === "string" && field.trim().length > 0);
	assert(owner.userId !== other.userId, "Two distinct users are required");
	return value;
}

async function currentUser(context, origin, expectedId) {
	const response = await context.request.get(`${origin}/api/v1/session`);
	assert.equal(response.status(), 200, "Current browser session must be valid");
	const session = await response.json();
	assert.equal(session.user?.userId, expectedId);
	return response.status();
}

async function conversationDetail(context, origin, conversationId) {
	const response = await context.request.get(
		`${origin}/api/v2/conversations/${encodeURIComponent(conversationId)}`,
	);
	assert.equal(
		response.status(),
		200,
		"Persisted conversation must be readable",
	);
	return response.json();
}

async function conversationStream(context, origin, conversationId) {
	return context.request.get(
		`${origin}/api/v2/conversations/${encodeURIComponent(conversationId)}/events`,
	);
}

async function run(input, evidence) {
	await privateFile(input.owner.stateFile);
	await privateFile(input.other.stateFile);
	const browser = await chromium.launch();
	try {
		const owner = await browser.newContext({
			storageState: input.owner.stateFile,
			viewport: { width: 1440, height: 1000 },
		});
		const other = await browser.newContext({
			storageState: input.other.stateFile,
			viewport: { width: 390, height: 844 },
		});
		evidence.sessions = {
			owner: await currentUser(owner, input.origin, input.owner.userId),
			other: await currentUser(other, input.origin, input.other.userId),
		};
		const page = await owner.newPage();
		await page.addInitScript(() => {
			window.__agentInfraSseFrames = [];
			window.__agentInfraAssistantSnapshots = [];
			const recordAssistantSnapshot = () => {
				const length = [
					...document.querySelectorAll(".assistant-markdown"),
				].reduce(
					(max, node) => Math.max(max, node.textContent?.trim().length ?? 0),
					0,
				);
				if (length > 0)
					window.__agentInfraAssistantSnapshots.push({
						at: performance.now(),
						length,
					});
			};
			new MutationObserver(recordAssistantSnapshot).observe(document, {
				characterData: true,
				childList: true,
				subtree: true,
			});
			const fetchImpl = window.fetch.bind(window);
			window.fetch = async (input, init) => {
				const response = await fetchImpl(input, init);
				const url = new URL(
					typeof input === "string"
						? input
						: input instanceof Request
							? input.url
							: String(input),
					window.location.href,
				);
				if (!url.pathname.endsWith("/events") || !response.body)
					return response;
				let pending = "";
				const decoder = new TextDecoder();
				const stream = response.body.pipeThrough(
					new TransformStream({
						transform(chunk, controller) {
							pending += decoder
								.decode(chunk, { stream: true })
								.replaceAll("\r\n", "\n");
							let boundary = pending.indexOf("\n\n");
							while (boundary >= 0) {
								const frame = pending.slice(0, boundary);
								pending = pending.slice(boundary + 2);
								const id = frame.match(/^id: ([^\n]+)$/m)?.[1];
								const data = frame.match(/^data: (.+)$/m)?.[1];
								if (id && data) {
									try {
										const parsed = JSON.parse(data);
										window.__agentInfraSseFrames.push({
											id,
											status:
												parsed.type === "execution.status"
													? parsed.payload?.status
													: undefined,
											textLength:
												parsed.type === "text.delta" &&
												typeof parsed.payload?.text === "string"
													? parsed.payload.text.length
													: undefined,
											type: parsed.type,
											at: performance.now(),
										});
									} catch {}
								}
								boundary = pending.indexOf("\n\n");
							}
							controller.enqueue(chunk);
						},
					}),
				);
				return new Response(stream, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				});
			};
		});
		await page.goto(
			`${input.origin}/agents/${encodeURIComponent(input.agentId)}/conversations`,
		);
		await expect(page.getByRole("button", { name: "创建会话" })).toBeEnabled();
		const [created] = await Promise.all([
			page.waitForResponse(
				(response) =>
					response.request().method() === "POST" &&
					new URL(response.url()).pathname ===
						`/api/v1/agents/${encodeURIComponent(input.agentId)}/conversations`,
			),
			page.getByRole("button", { name: "创建会话" }).click(),
		]);
		assert.equal(created.status(), 201);
		const { conversationId } = await created.json();
		assert(typeof conversationId === "string" && conversationId.length > 0);
		evidence.createStatus = created.status();
		evidence.conversationHash = digest(conversationId);
		await expect(page.getByRole("textbox", { name: "消息" })).toBeEnabled();
		await page.getByRole("textbox", { name: "消息" }).fill(input.prompt);
		const [submitted] = await Promise.all([
			page.waitForResponse(
				(response) =>
					response.request().method() === "POST" &&
					new URL(response.url()).pathname ===
						`/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
			),
			page.getByRole("button", { name: "发送", exact: true }).click(),
		]);
		assert.equal(submitted.status(), 202);
		const receipt = await submitted.json();
		assert(typeof receipt.executionId === "string" && receipt.executionId);
		evidence.submitStatus = submitted.status();
		evidence.executionHash = digest(receipt.executionId);
		await expect
			.poll(
				async () => {
					const detail = await conversationDetail(
						owner,
						input.origin,
						conversationId,
					);
					return detail.messages?.some(
						(message) =>
							message.role === "assistant" &&
							message.executionId === receipt.executionId &&
							message.status === "completed" &&
							Boolean(message.text?.trim()),
					);
				},
				{ timeout: 180_000, intervals: [500, 1000, 2000] },
			)
			.toBe(true);
		const detail = await conversationDetail(
			owner,
			input.origin,
			conversationId,
		);
		const events = detail.events ?? [];
		assert(events.length > 0 && events.every((event) => event.eventId));
		assert.equal(
			new Set(events.map((event) => event.eventId)).size,
			events.length,
		);
		await expect(page.locator(".assistant-markdown").last()).not.toBeEmpty();
		const sseFrames = await page.evaluate(
			() => window.__agentInfraSseFrames ?? [],
		);
		const assistantSnapshots = await page.evaluate(
			() => window.__agentInfraAssistantSnapshots ?? [],
		);
		assert(
			sseFrames.length >= 2,
			"Browser must observe incremental SSE frames",
		);
		const firstFrame = sseFrames.find(
			(frame) => frame.type === "text.delta" && frame.textLength > 0,
		);
		const terminalFrame = sseFrames.find(
			(frame) =>
				frame.type === "execution.status" && frame.status === "completed",
		);
		assert(
			firstFrame && terminalFrame,
			"SSE must include text and terminal frames",
		);
		assert(
			assistantSnapshots.some((snapshot) => snapshot.at < terminalFrame.at),
			"The page must display assistant text before the terminal frame",
		);
		assert(
			firstFrame.at < terminalFrame.at,
			"An incremental text frame must arrive before the terminal frame",
		);
		evidence.sse = {
			status: 200,
			eventCount: events.length,
			eventIdHashes: events.map((event) => digest(event.eventId)),
			observedFrames: sseFrames.map((frame) => ({
				idHash: digest(frame.id),
				type: frame.type,
				status: frame.status ?? null,
				textLength: frame.textLength ?? null,
			})),
			cursorHash: detail.conversation.lastConversationCursor
				? digest(detail.conversation.lastConversationCursor)
				: null,
		};
		await page.screenshot({
			path: join(evidence.directory, "conversation-desktop.png"),
		});
		await page.reload();
		await expect(page.locator(".assistant-markdown").last()).not.toBeEmpty();
		const restored = await conversationDetail(
			owner,
			input.origin,
			conversationId,
		);
		assert.deepEqual(
			restored.events.slice(0, events.length).map((event) => event.eventId),
			events.map((event) => event.eventId),
			"Reload must preserve the original event sequence",
		);
		assert.equal(
			new Set(restored.events.map((event) => event.eventId)).size,
			restored.events.length,
		);
		evidence.reload = "restored";
		await page.setViewportSize({ width: 390, height: 844 });
		await expect(page.locator(".assistant-markdown").last()).not.toBeEmpty();
		assert(
			await page.evaluate(
				() =>
					Math.max(
						document.documentElement.scrollWidth,
						document.body.scrollWidth,
					) <= window.innerWidth,
			),
			"Mobile conversation must not overflow horizontally",
		);
		await page.screenshot({
			path: join(evidence.directory, "conversation-mobile.png"),
		});
		const denied = await other.request.get(
			`${input.origin}/api/v2/conversations/${encodeURIComponent(conversationId)}`,
		);
		assert([403, 404].includes(denied.status()));
		evidence.crossUserReadStatus = denied.status();
		const deniedStream = await conversationStream(
			other,
			input.origin,
			conversationId,
		);
		assert([403, 404].includes(deniedStream.status()));
		evidence.crossUserSseStatus = deniedStream.status();
		const otherPage = await other.newPage();
		await otherPage.goto(
			`${input.origin}/agents/${encodeURIComponent(input.agentId)}/conversations?conversation=${encodeURIComponent(conversationId)}`,
		);
		await expect(
			otherPage.getByText(input.prompt, { exact: true }),
		).toHaveCount(0);
		await otherPage.screenshot({
			path: join(evidence.directory, "cross-user-mobile.png"),
		});
	} finally {
		await browser.close();
	}
}

const configPath = process.argv[2];
assert(
	configPath,
	"Pass the absolute path to a private browser journey config",
);
await privateFile(configPath);
const input = configuration(JSON.parse(await readFile(configPath, "utf8")));
const directory = await mkdtemp(join(tmpdir(), "agent-infra-real-browser-"));
const evidence = {
	schemaVersion: 1,
	classification: "authenticated-browser-consumer",
	directory,
	commit: execFileSync("git", ["rev-parse", "HEAD"], {
		encoding: "utf8",
	}).trim(),
	worktreeDirty: Boolean(
		execFileSync("git", ["status", "--porcelain"], {
			encoding: "utf8",
		}).trim(),
	),
	origin: input.origin,
	agentHash: digest(input.agentId),
	modelCallVerified: false,
	connectionVerified: false,
};
try {
	await run(input, evidence);
	evidence.result = "passed";
} catch (error) {
	evidence.result = "failed";
	evidence.failureClass = error instanceof Error ? error.name : "Unknown";
	process.exitCode = 1;
}
await writeFile(
	join(directory, "evidence.json"),
	JSON.stringify(evidence, null, 2),
	{
		mode: 0o600,
	},
);
process.stdout.write(`${directory}\n`);
