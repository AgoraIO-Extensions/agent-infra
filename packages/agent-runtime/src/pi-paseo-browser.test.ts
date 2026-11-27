import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RuntimeOperationFactV2 } from "@agent-infra/contracts/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it, vi } from "vitest";
import {
	browserConformanceBinding,
	browserConformanceCapability,
} from "./browser-conformance.test-support.js";
import type { RuntimeBrowserToolExecutionRequestV1 } from "./driver.js";
import { openRuntimeMessagesTransport } from "./messages-model-transport.js";
import { piPodArguments } from "./paseo-pod.js";
import { verifyPiInstallation } from "./pi-installation.js";
import { writePiConfiguration } from "./pi-launch-configuration.js";
import {
	openPiPaseoBrowser,
	piPaseoBrowserLaunch,
	piPaseoBrowserTools,
} from "./pi-paseo-browser.js";

type ToolCall = { name: string; input: Record<string, unknown> };

function reply(
	response: ServerResponse,
	turn: number,
	result: ToolCall | string,
) {
	const text = typeof result === "string";
	const start = text
		? { type: "text", text: "" }
		: { type: "tool_use", id: `call_${turn}`, name: result.name, input: {} };
	const delta = text
		? { type: "text_delta", text: result }
		: { type: "input_json_delta", partial_json: JSON.stringify(result.input) };
	const events = [
		{
			type: "message_start",
			message: {
				id: `msg_${turn}`,
				type: "message",
				role: "assistant",
				model: "claude-opus-5",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: start },
		{ type: "content_block_delta", index: 0, delta },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: {
				stop_reason: text ? "end_turn" : "tool_use",
				stop_sequence: null,
			},
			usage: { output_tokens: 4 },
		},
		{ type: "message_stop" },
	];
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end(
		events
			.map(
				(event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
			)
			.join(""),
	);
}

async function runPiReport(withSkill: boolean) {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "pi-browser-report-")),
	);
	const cwd = join(root, "workspace");
	const config = join(root, "config");
	const page = { pageId: "page-1", pageRevision: 1 };
	const prefix = "mcp__agent-infra-browser__browser_";
	const actions: string[] = [];
	const facts: RuntimeOperationFactV2[] = [];
	let clickedValue: string | undefined;
	const executeTool = async (request: RuntimeBrowserToolExecutionRequestV1) => {
		actions.push(request.tool);
		if (request.tool === "browser_interact") clickedValue = randomUUID();
		const observation =
			request.tool === "browser_observe"
				? {
						...page,
						text: clickedValue ?? "Ready",
						elements: [{ elementId: "button-1", name: "Continue" }],
					}
				: page;
		return {
			actionId: request.actionId,
			operationRef: request.operationRef,
			attemptRef: request.attemptRef,
			binding: request.binding,
			phase: "completed" as const,
			sideEffect: false,
			success: true,
			contentItems: [
				{ type: "inputText" as const, text: JSON.stringify(observation) },
			],
		};
	};
	const grant = vi.fn(async () => ({ revalidate: vi.fn() }));
	const gateway = await openPiPaseoBrowser(
		{
			directory: root,
			cwd,
			runtimeSessionRef: "pi-session",
			executionId: "execution-1",
			selection: {
				schemaVersion: 1,
				modelOptionId: "test",
				reasoningLevel: "high",
			},
			admit: vi.fn(),
			update: vi.fn(),
			recordOperationFact: async (fact) => {
				facts.push(fact);
			},
			browser: {
				binding: {
					...browserConformanceBinding,
					imageDigest: browserConformanceCapability.provenance.imageDigest,
				},
				capabilityVersion: browserConformanceCapability.capabilityVersion,
				observedSideEffect: () => false,
				executeTool,
			},
		},
		() => ({
			...browserConformanceCapability,
			conformance: {
				...browserConformanceCapability.conformance,
				receiptId: randomUUID(),
				verifiedAt: new Date().toISOString(),
			},
		}),
		grant,
	);
	let calls = 0;
	const catalogs: string[][] = [];
	let observedByModel = false;
	const relay = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const part of request) chunks.push(part);
		const message = JSON.parse(Buffer.concat(chunks).toString());
		catalogs.push(
			message.tools?.map((tool: { name: string }) => tool.name).sort() ?? [],
		);
		const last = JSON.stringify(message.messages?.at(-1));
		if (clickedValue && last?.includes(clickedValue)) observedByModel = true;
		const plan: (ToolCall | string)[] = [
			{ name: `${prefix}navigate`, input: { url: "https://example.test/" } },
			{ name: `${prefix}observe`, input: page },
			{
				name: `${prefix}interact`,
				input: { ...page, elementId: "button-1", kind: "click" },
			},
			{ name: `${prefix}observe`, input: page },
			{
				name: "mcp__agent-infra-browser__write_report",
				input: {
					path: "report.txt",
					content: observedByModel ? clickedValue : "missing observation",
				},
			},
			"[Report](sandbox:report.txt)",
		];
		reply(response, calls + 1, plan[calls++] ?? "finished");
	});
	let transport:
		| Awaited<ReturnType<typeof openRuntimeMessagesTransport>>
		| undefined;
	const authorizeModel = vi.fn(async () => ({
		resolveCredential: async () => "synthetic-provider-credential",
		revalidate: vi.fn(),
	}));
	try {
		await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
		const address = relay.address();
		if (!address || typeof address === "string")
			throw new Error("Missing test relay");
		await Promise.all([mkdir(cwd), mkdir(config)]);
		const folders = withSkill ? ["report"] : [];
		if (withSkill) {
			const folder = join(root, ".agents", "skills", "report");
			await mkdir(folder, { recursive: true });
			await writeFile(
				join(folder, "SKILL.md"),
				"---\nname: report\ndescription: Test report instructions.\n---\nUse the observed value.\n",
			);
		}
		transport = await openRuntimeMessagesTransport({
			client: "pi",
			model: "claude-opus-5",
			effort: "high",
			authentication: "api-key",
			endpoint: `http://127.0.0.1:${address.port}`,
			admit: vi.fn(),
			openRequest: authorizeModel,
			permittedClientTools: piPaseoBrowserTools(gateway.permit.operations),
			...(withSkill ? { piSkills: { folders, read: vi.fn() } } : {}),
		});
		await writePiConfiguration(
			config,
			"claude-opus-5",
			["high"],
			"high",
			transport.modelAccess.endpoint,
			false,
		);
		const pi = await verifyPiInstallation();
		const launch = piPaseoBrowserLaunch(gateway.permit, withSkill);
		const printing = promisify(execFile)(
			pi.executable,
			[
				pi.cli,
				...(await piPodArguments(folders, root, launch.args)),
				"--no-session",
				"--print",
				"Use the test page and deliver a text report.",
			],
			{
				cwd,
				timeout: 25_000,
				env: {
					PATH: process.env.PATH,
					HOME: root,
					PI_CODING_AGENT_DIR: config,
					AGENT_INFRA_PI_WORKSPACE: cwd,
					AGENT_INFRA_PI_MODEL_TOKEN: transport.modelAccess.credential,
					...(withSkill
						? {
								AGENT_INFRA_PI_SKILL_READER:
									transport.modelAccess.endpoint + "/pi/skill-read",
							}
						: {}),
					...launch.env,
				},
			},
		);
		printing.child.stdin?.end();
		const run = await printing;
		expect(run.stdout).toContain("[Report](sandbox:report.txt)");
		expect(catalogs[0]).toEqual(
			["interact", "navigate", "observe"]
				.map((name) => prefix + name)
				.concat(
					"mcp__agent-infra-browser__write_report",
					...(withSkill ? ["read"] : []),
				),
		);
		expect(actions).toEqual([
			"browser_navigate",
			"browser_observe",
			"browser_interact",
			"browser_observe",
		]);
		expect(grant).toHaveBeenCalledTimes(actions.length + 1);
		expect(
			facts
				.slice(-3)
				.map((fact) => [fact.phase, fact.kind === "tool" && fact.toolId]),
		).toEqual(
			["intent", "started", "completed"].map((phase) => [
				phase,
				"workspace:write_report",
			]),
		);
		expect(authorizeModel).toHaveBeenCalledTimes(calls);
		for (const [index, action] of actions.entries()) {
			const attempt = facts.slice(index * 3, index * 3 + 3);
			expect(
				attempt.every(
					(f) => f.kind === "tool" && f.browser?.sideEffect === false,
				),
			).toBe(true);
			expect(attempt.map((f) => f.phase)).toEqual([
				"intent",
				"started",
				"completed",
			]);
			expect(attempt[0]).toMatchObject({
				kind: "tool",
				toolId: `browser:${action}`,
				browser: { resourceFence: browserConformanceBinding.resourceFence },
			});
			expect(grant.mock.calls[index]).toEqual([
				expect.objectContaining({
					executionId: "execution-1",
					operationRef: attempt[0]?.operationRef,
					attemptRef: attempt[0]?.attemptRef,
				}),
			]);
		}
		expect(observedByModel).toBe(true);
		expect(await readFile(join(cwd, "report.txt"), "utf8")).toBe(clickedValue);
	} finally {
		await transport?.close();
		relay.closeAllConnections();
		await new Promise<void>((resolve) => relay.close(() => resolve()));
		await gateway.close();
		await rm(root, { recursive: true, force: true });
	}
}

it.each([false, true])(
	"installed Pi saves the observed value with deployment Skills enabled=%s",
	runPiReport,
	35_000,
);

it.each([
	"revoked grant",
	"stale probe",
	"unconfirmed reply",
	"live policy denial",
	"missing report directory",
] as const)(
	"honors a %s at the browser dispatch boundary",
	async (boundary) => {
		const phases: string[] = [];
		const failures: string[] = [];
		let current: typeof browserConformanceCapability | undefined =
			browserConformanceCapability;
		let revoked = false;
		const markUnknown = vi.fn();
		const closeBrowser = vi.fn();
		const executeTool = vi.fn(
			async (request: RuntimeBrowserToolExecutionRequestV1) => ({
				...request,
				actionId:
					boundary === "live policy denial"
						? request.actionId
						: "unconfirmed-action",
				phase:
					boundary === "live policy denial"
						? ("failed" as const)
						: ("completed" as const),
				...(boundary === "live policy denial"
					? { failureCode: "BROWSER_SIDE_EFFECTS_UNAVAILABLE" }
					: {}),
				contentItems: [],
				success: boundary !== "live policy denial",
			}),
		);
		const gateway = await openPiPaseoBrowser(
			{
				directory: "/test",
				cwd: "/test/workspace",
				runtimeSessionRef: "pi-session",
				executionId: "execution-1",
				selection: {
					schemaVersion: 1,
					modelOptionId: "test",
					reasoningLevel: "high",
				},
				admit: vi.fn(),
				update: vi.fn(),
				markUnknown,
				recordOperationFact: async (fact) => {
					phases.push(fact.phase);
					if (fact.failureCode) failures.push(fact.failureCode);
					if (fact.phase === "started") {
						if (boundary === "revoked grant") revoked = true;
						if (boundary === "stale probe") current = undefined;
					}
				},
				browser: {
					binding: {
						...browserConformanceBinding,
						imageDigest: browserConformanceCapability.provenance.imageDigest,
					},
					capabilityVersion: browserConformanceCapability.capabilityVersion,
					executeTool,
					observedSideEffect: () => false,
					close: closeBrowser,
				},
			},
			() => current,
			async () => ({
				revalidate() {
					if (revoked) throw new Error("RUNTIME_AUTHORIZATION_DENIED");
				},
			}),
		);
		const client = new Client({ name: "pi-browser-grant-test", version: "1" });
		try {
			const transport = new StreamableHTTPClientTransport(
				new URL(`http://127.0.0.1:${gateway.permit.port}/mcp`),
				{
					requestInit: {
						headers: { Authorization: `Bearer ${gateway.permit.token}` },
					},
				},
			);
			await client.connect(transport);
			const tool =
				boundary === "live policy denial"
					? {
							name: "browser_interact",
							arguments: {
								pageId: "page-1",
								pageRevision: 1,
								elementId: "element-1",
								kind: "click",
							},
						}
					: boundary === "missing report directory"
						? {
								name: "write_report",
								arguments: { path: "report.txt", content: "test" },
							}
						: {
								name: "browser_navigate",
								arguments: { url: "https://example.test/" },
							};
			const result = await client.callTool(tool);
			expect(result.isError).toBe(true);
			const uncertain = boundary === "unconfirmed reply";
			const dispatched = uncertain || boundary === "live policy denial";
			if (boundary === "live policy denial")
				expect(failures).toEqual(["authorization_denied"]);
			expect(phases).toEqual([
				"intent",
				"started",
				uncertain ? "unknown" : "failed",
			]);
			expect(executeTool).toHaveBeenCalledTimes(dispatched ? 1 : 0);
			expect(markUnknown).toHaveBeenCalledTimes(uncertain ? 1 : 0);
		} finally {
			await client.close();
			await gateway.close();
		}
		expect(closeBrowser).toHaveBeenCalledOnce();
	},
);
