import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	assertTurnReply,
	conversationTurns,
} from "./local-real-e2e/conversation-turn-plan.ts";

test("multi-turn plans reject missing expectations, truncation and unbounded turns without quoting private replies", () => {
	const prompt = "private-prompt-canary";
	assert.equal(conversationTurns({ prompt }).length, 1);
	assert.throws(
		() => conversationTurns({ prompt, followUpPrompts: ["second"] }),
		/TURN_EXPECTATIONS_REQUIRED/,
	);
	assert.throws(
		() => conversationTurns({ prompt, followUpPrompts: Array(5).fill("x") }),
		/TURN_PLAN_INVALID/,
	);
	try {
		assertTurnReply("P", "private-reply-canary");
		assert.fail("truncation accepted");
	} catch (error) {
		assert.match(error.message, /TURN_REPLY_MISMATCH/);
		assert(!error.message.includes("private-reply-canary"));
	}
});

// Controlled browser plumbing only: no real model, LDAP, Registry, or ACK resources.
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>body { max-width:100%; overflow-wrap:anywhere } textarea { max-width:80% }</style>
<div id="history"></div><textarea aria-label="消息" disabled></textarea><button>发送</button>
<script>
const historyElement=document.querySelector("#history");
const box=document.querySelector("textarea");
let conversation=new URL(location.href).searchParams.get("conversation");
function addMessage(role,text) {
 const node=document.createElement("div");node.className=role==="assistant"?"assistant-markdown":"message-text";
 node.textContent=text;historyElement.append(node);return node;
}
async function load() {
 if(conversation) {
  const detail=await (await fetch("/api/v2/conversations/"+conversation)).json();
  for(const message of detail.messages) addMessage(message.role,message.text);
 }
 box.disabled=false;
}
document.querySelector("button").onclick=async()=>{
 box.disabled=true;
 const text=box.value;addMessage("user",text);box.value="";
 if(!conversation){
  conversation=(await (await fetch("/api/v1/agents/agent/conversations",{method:"POST"})).json()).conversationId;
  window.history.replaceState(null,"","?conversation="+conversation);
  await new Promise(resolve=>setTimeout(resolve,SESSION_PREPARATION_MS));
 }
 const accepted=await (await fetch("/api/v1/conversations/"+conversation+"/messages",{method:"POST",body:JSON.stringify({text})})).json();
 const node=addMessage("assistant","");
 const stream=await fetch("/api/v2/conversations/"+conversation+"/events");
 const reader=stream.body.getReader();const decoder=new TextDecoder();let pending="";
 while(true){
  const chunk=await reader.read();if(chunk.done)break;pending+=decoder.decode(chunk.value);
  let end;while((end=pending.indexOf("\\n\\n"))>=0){
   const frame=pending.slice(0,end);pending=pending.slice(end+2);
   const event=JSON.parse(frame.split("\\n").find(line=>line.startsWith("data: ")).slice(6));
   if(event.type==="text.delta")node.textContent+=event.payload.text;
  }
 }
 box.disabled=false;
};
load();
</script>`;

for (const { truncate, sessionPreparationMs } of [
	{ truncate: false, sessionPreparationMs: 0 },
	{ truncate: true, sessionPreparationMs: 0 },
	{ truncate: false, sessionPreparationMs: 31_000 },
]) {
	test(`controlled browser runs same-session turns (truncate second reply=${truncate}, preparation=${sessionPreparationMs}ms)`, {
		// biome-ignore lint/suspicious/noUndeclaredEnvVars: This opt-in test runs via node --test outside Turbo.
		skip: process.env.ACK_BROWSER_FIXTURE_TEST !== "1",
		timeout: 60_000,
	}, async () => {
		const prompts = [
			"first controlled prompt",
			"second controlled prompt",
			"third controlled prompt",
		];
		const expected = ["LONG FIRST REPLY", "PI-OK", "THIRD-OK"];
		const events = [];
		const messages = [];
		let creations = 0;
		let turns = 0;
		const server = createServer(async (request, response) => {
			const owner = request.headers.cookie?.includes("role=owner");
			const url = new URL(request.url, "http://fixture.test");
			const json = (value, status = 200) => {
				response.writeHead(status, { "content-type": "application/json" });
				response.end(JSON.stringify(value));
			};
			if (url.pathname === "/api/v1/session")
				return json({ user: { userId: owner ? "owner" : "other" } });
			if (url.pathname.startsWith("/agents/")) {
				response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				return response.end(
					owner
						? html.replace(
								"SESSION_PREPARATION_MS",
								String(sessionPreparationMs),
							)
						: "<p>当前登录或访问权限已失效，请重新登录或返回 Agent 目录。</p>",
				);
			}
			if (!owner) return json({}, 403);
			if (
				url.pathname.endsWith("/conversations") &&
				request.method === "POST"
			) {
				creations++;
				return json({ conversationId: "same-conversation" }, 201);
			}
			if (url.pathname.endsWith("/messages") && request.method === "POST") {
				let bytes = "";
				for await (const chunk of request) bytes += chunk;
				const { text } = JSON.parse(bytes);
				turns++;
				messages.push({ role: "user", text });
				return json(
					{ executionId: `execution-${turns}`, status: "submitted" },
					202,
				);
			}
			if (url.pathname.endsWith("/events")) {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.flushHeaders();
				const executionId = `execution-${turns}`;
				const answer = truncate && turns === 2 ? "P" : expected[turns - 1];
				const emit = (type, payload) => {
					const event = {
						eventId: `event-${events.length}`,
						conversationId: "same-conversation",
						executionId,
						type,
						payload,
					};
					events.push(event);
					response.write(
						`id: ${event.eventId}\ndata: ${JSON.stringify(event)}\n\n`,
					);
				};
				setTimeout(() => emit("text.delta", { text: answer.slice(0, 1) }), 100);
				setTimeout(() => emit("text.delta", { text: answer.slice(1) }), 250);
				setTimeout(() => {
					messages.push({
						role: "assistant",
						text: answer,
						status: "completed",
						executionId,
					});
					emit("execution.status", { status: "completed" });
					response.end();
				}, 450);
				return;
			}
			if (url.pathname === "/api/v2/conversations/same-conversation")
				return json({
					conversation: {
						conversationId: "same-conversation",
						lastConversationCursor: "cursor",
					},
					messages,
					events,
				});
			json({}, 404);
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const origin = `http://127.0.0.1:${server.address().port}`;
		const directory = await mkdtemp(join(tmpdir(), "ack-browser-fixture-"));
		for (const role of ["owner", "other"]) {
			await writeFile(
				join(directory, `${role}.json`),
				JSON.stringify({
					cookies: [
						{
							name: "role",
							value: role,
							domain: "127.0.0.1",
							path: "/",
							expires: -1,
							httpOnly: true,
							secure: false,
							sameSite: "Lax",
						},
					],
					origins: [],
				}),
				{ mode: 0o600 },
			);
		}
		const config = join(directory, "config.json");
		await writeFile(
			config,
			JSON.stringify({
				origin,
				agentId: "agent",
				prompt: prompts[0],
				followUpPrompts: prompts.slice(1),
				expectedReplies: expected,
				owner: { userId: "owner", stateFile: join(directory, "owner.json") },
				other: { userId: "other", stateFile: join(directory, "other.json") },
			}),
			{ mode: 0o600 },
		);
		const child = spawn(
			process.execPath,
			[
				join(import.meta.dirname, "local-real-e2e/conversation-browser.mjs"),
				config,
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		const timer = setTimeout(() => child.kill("SIGTERM"), 50_000);
		try {
			const [status] = await once(child, "close");
			assert.equal(stderr, "");
			const result = JSON.parse(
				await readFile(join(stdout.trim(), "evidence.json"), "utf8"),
			);
			assert.equal(creations, 1);
			assert.equal(turns, truncate ? 2 : 3);
			assert.equal(status, truncate ? 1 : 0);
			assert.equal(result.completedTurnCount, truncate ? 1 : 3);
			assert.equal(result.result, truncate ? "failed" : "passed");
			if (sessionPreparationMs > 0)
				assert(
					result.turns[0].timings.browserClickToAcceptedMs >=
						sessionPreparationMs,
				);
			if (truncate) assert.equal(result.turns[1].result, "failed");
			assert.equal(
				new Set(result.turns.map((turn) => turn.conversationHash)).size,
				1,
			);
			assert.equal(
				new Set(result.turns.map((turn) => turn.executionHash)).size,
				turns,
			);
			if (!truncate)
				for (const turn of result.turns) {
					assert.equal(turn.reload, "restored");
					assert(
						turn.timings.browserClickToCompletedMs >
							turn.timings.browserClickToFirstTextMs,
					);
					assert.equal(turn.timings.modelDurationMs, null);
				}
			for (const privateText of [...prompts, ...expected])
				assert(!JSON.stringify(result).includes(privateText));
			assert.equal(result.modelCallVerified, false);
		} finally {
			clearTimeout(timer);
			child.kill();
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
	});
}
