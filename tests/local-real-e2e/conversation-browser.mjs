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
let chromium;
let expect;

function loadBrowserDependency() {
	if (chromium && expect) return;
	({ chromium, expect } = requireWebDependency("@playwright/test"));
}

function digest(value) {
	return createHash("sha256").update(value).digest("hex");
}

function nonEmptyString(value, message) {
	assert(typeof value === "string" && value.trim().length > 0, message);
	return value;
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
	nonEmptyString(origin, "origin is required");
	const url = new URL(origin);
	assert(
		(url.protocol === "https:" ||
			(url.protocol === "http:" && url.hostname === "127.0.0.1")) &&
			url.origin === origin &&
			!url.username &&
			!url.password,
		"Use an HTTPS origin or loopback HTTP origin",
	);
	nonEmptyString(agentId, "agentId is required");
	nonEmptyString(prompt, "prompt is required");
	for (const subject of [owner, other]) {
		assert(
			subject && typeof subject === "object" && !Array.isArray(subject),
			"owner and other subjects are required",
		);
		nonEmptyString(subject.userId, "subject userId is required");
		nonEmptyString(subject.stateFile, "subject stateFile is required");
		assert(
			isAbsolute(subject.stateFile),
			"Browser state files must have absolute paths",
		);
	}
	assert(owner.userId !== other.userId, "Two distinct users are required");
	assert(
		owner.stateFile !== other.stateFile,
		"Two independent browser state files are required",
	);
	return value;
}

async function validateStorageState(path) {
	let parsed;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch {
		assert.fail("Browser state file must contain valid JSON");
	}
	assert(
		parsed && typeof parsed === "object" && !Array.isArray(parsed),
		"Browser state file must contain an object",
	);
	assert(
		Array.isArray(parsed.cookies) && Array.isArray(parsed.origins),
		"Browser state file must contain Playwright cookies and origins arrays",
	);
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
		{ timeout: 10_000 },
	);
}

async function run(input, evidence) {
	await privateFile(input.owner.stateFile);
	await privateFile(input.other.stateFile);
	loadBrowserDependency();
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
			window.__agentInfraAssistantRenders = [];
			window.__agentInfraStreamStartAssistantLength = 0;
			const assistantTextLength = () =>
				[...document.querySelectorAll(".assistant-markdown")].reduce(
					(max, node) => Math.max(max, node.textContent?.trim().length ?? 0),
					0,
				);
			let lastAssistantLength = 0;
			const recordAssistantRender = () => {
				const visibleTextLength = assistantTextLength();
				if (visibleTextLength <= lastAssistantLength) return;
				lastAssistantLength = visibleTextLength;
				window.__agentInfraAssistantRenders.push({
					at: performance.now(),
					visibleTextLength,
				});
			};
			new MutationObserver(recordAssistantRender).observe(document, {
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
				window.__agentInfraStreamStartAssistantLength = assistantTextLength();
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
											visibleTextLength: assistantTextLength(),
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
		assert(
			["submitted", "processing"].includes(receipt.status),
			"Message must be newly accepted",
		);
		assert(typeof receipt.executionId === "string" && receipt.executionId);
		evidence.submitStatus = submitted.status();
		evidence.executionHash = digest(receipt.executionId);
		await expect
			.poll(
				() =>
					page.evaluate(() => {
						const frames = window.__agentInfraSseFrames ?? [];
						const firstFrame = frames.find(
							(frame) => frame.type === "text.delta" && frame.textLength > 0,
						);
						const terminalFrame = frames.find(
							(frame) =>
								frame.type === "execution.status" &&
								frame.status === "completed",
						);
						return Boolean(
							firstFrame &&
								terminalFrame &&
								firstFrame.at < terminalFrame.at &&
								terminalFrame.visibleTextLength >
									(window.__agentInfraStreamStartAssistantLength ?? 0),
						);
					}),
				{ timeout: 180_000, intervals: [500, 1000, 2000] },
			)
			.toBe(true);
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
		assert(
			events.length > 0 &&
				events.every(
					(event) =>
						event.eventId &&
						event.conversationId === conversationId &&
						event.executionId === receipt.executionId,
				),
			"Persisted events must stay bound to this conversation and execution",
		);
		assert.equal(
			new Set(events.map((event) => event.eventId)).size,
			events.length,
		);
		const sseFrames = await page.evaluate(
			() => window.__agentInfraSseFrames ?? [],
		);
		const streamStartAssistantLength = await page.evaluate(
			() => window.__agentInfraStreamStartAssistantLength ?? 0,
		);
		const assistantRenders = await page.evaluate(
			() => window.__agentInfraAssistantRenders ?? [],
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
			assistantRenders.some(
				(render) =>
					render.at >= firstFrame.at &&
					render.at < terminalFrame.at &&
					render.visibleTextLength > streamStartAssistantLength,
			),
			"The page must render incremental assistant text before the terminal frame",
		);
		assert(
			firstFrame.at < terminalFrame.at,
			"An incremental text frame must arrive before the terminal frame",
		);
		await expect(page.locator(".assistant-markdown").last()).not.toBeEmpty();
		evidence.sse = {
			status: 200,
			eventCount: events.length,
			eventIdHashes: events.map((event) => digest(event.eventId)),
			observedFrames: sseFrames.map((frame) => ({
				idHash: digest(frame.id),
				type: frame.type,
				status: frame.status ?? null,
				textLength: frame.textLength ?? null,
				visibleTextLength: frame.visibleTextLength,
			})),
			assistantRenders: assistantRenders.map((render) => ({
				visibleTextLength: render.visibleTextLength,
			})),
			cursorHash: detail.conversation.lastConversationCursor
				? digest(detail.conversation.lastConversationCursor)
				: null,
		};
		await page.screenshot({
			path: join(evidence.directory, "conversation-desktop.png"),
			mask: [
				page.locator(".message-text"),
				page.locator(".assistant-markdown"),
			],
		});
		const renderedAnswer = await page
			.locator(".assistant-markdown")
			.last()
			.innerText();
		assert(renderedAnswer.trim(), "Completed assistant reply must be visible");
		await page.reload();
		await expect(page.locator(".assistant-markdown").last()).toHaveText(
			renderedAnswer,
		);
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
			mask: [
				page.locator(".message-text"),
				page.locator(".assistant-markdown"),
			],
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
			otherPage.getByText(
				"当前登录或访问权限已失效，请重新登录或返回 Agent 列表。",
			),
		).toBeVisible();
		await expect(
			otherPage.getByText(input.prompt, { exact: true }),
		).toHaveCount(0);
		await expect(otherPage.locator(".assistant-markdown")).toHaveCount(0);
		await otherPage.screenshot({
			path: join(evidence.directory, "cross-user-mobile.png"),
		});
	} finally {
		await browser.close();
	}
}

const checkConfig = process.argv[2] === "--check-config";
const configPath = checkConfig ? process.argv[3] : process.argv[2];
assert(
	configPath,
	`Pass the absolute path to a private browser journey config${checkConfig ? " after --check-config" : ""}`,
);
await privateFile(configPath);
const input = configuration(JSON.parse(await readFile(configPath, "utf8")));
await privateFile(input.owner.stateFile);
await privateFile(input.other.stateFile);
if (checkConfig) {
	await validateStorageState(input.owner.stateFile);
	await validateStorageState(input.other.stateFile);
	process.stdout.write(
		`${JSON.stringify({
			schemaVersion: 1,
			mode: "configuration-only",
			endpointChecked: false,
			origin: input.origin,
			agentHash: digest(input.agentId),
			ownerUserHash: digest(input.owner.userId),
			otherUserHash: digest(input.other.userId),
		})}\n`,
	);
	process.exit(0);
}
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
