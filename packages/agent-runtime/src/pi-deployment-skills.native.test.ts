import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { openRuntimeMessagesTransport } from "./messages-model-transport.js";
import { paseoModelRequest } from "./paseo-model-request.js";
import { piPodArguments } from "./paseo-pod.js";
import {
	openPiDeploymentSkills,
	piSessionSkillReader,
} from "./pi-deployment-skills.js";
import { verifyPiInstallation } from "./pi-installation.js";
import { writePiConfiguration } from "./pi-launch-configuration.js";

function response(model: string, text: string, readPath?: string) {
	const block = readPath
		? { type: "tool_use", id: "tool_read_skill", name: "read", input: {} }
		: { type: "text", text: "" };
	const delta = readPath
		? {
				type: "input_json_delta",
				partial_json: JSON.stringify({ path: readPath }),
			}
		: { type: "text_delta", text };
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_test",
				type: "message",
				role: "assistant",
				model,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: block },
		{ type: "content_block_delta", index: 0, delta },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: {
				stop_reason: readPath ? "tool_use" : "end_turn",
				stop_sequence: null,
			},
			usage: { output_tokens: 2 },
		},
		{ type: "message_stop" },
	];
	return new Response(
		events
			.map(
				(event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
			)
			.join(""),
		{ headers: { "Content-Type": "text/event-stream" } },
	);
}

it("lets pinned Pi read the creator's weekly report Skill on an ordinary first prompt", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-maintenance-")));
	const view = join(root, "published", "files");
	const folder = join(view, ".agents", "skills", "weekly-report");
	const entry = join(folder, "SKILL.md");
	const model = "test-weekly";
	const config = join(root, "config");
	await mkdir(folder, { recursive: true });
	await mkdir(config);
	await writeFile(
		entry,
		"---\nname: weekly-report\ndescription: Use for weekly reports.\n---\nAdd the heading 本周阻塞.\n",
	);
	await writeFile(join(root, "published", "sha256"), "f".repeat(64));
	const upstream = vi.fn<typeof fetch>(
		async (_url, init): Promise<Response> => {
			const body = JSON.parse(String(init?.body));
			const sawEntry = JSON.stringify(body.system).includes(entry);
			const hasRead = body.tools?.some(
				(tool: { name: string }) => tool.name === "read",
			);
			const usedSkill = body.messages.some(
				(message: { content: unknown }) =>
					Array.isArray(message.content) &&
					message.content.some(
						(block) =>
							block.type === "tool_result" &&
							!block.is_error &&
							JSON.stringify(block.content).includes(
								"Add the heading 本周阻塞.",
							),
					),
			);
			return response(
				model,
				usedSkill ? "本周阻塞" : "本周进展",
				sawEntry && hasRead && upstream.mock.calls.length === 1
					? entry
					: undefined,
			);
		},
	);
	const directory = await openPiDeploymentSkills({
		scope: "agent-a:conversation-a",
		execution: {
			agentId: "agent-a",
			conversationId: "conversation-a",
			executionId: "execution-a",
			sessionGeneration: 1,
		},
		root: view,
	});
	const authorize = vi.fn(async () => ({ revalidate: () => {} }));
	const authorizeModel = vi.fn(async () => ({
		relayKey: "synthetic-test-only-credential",
		revalidate: () => {},
	}));
	const confirmed = vi.fn();
	const session = {
		directory: config,
		cwd: root,
		admit: async () => {},
		selection: {
			schemaVersion: 1 as const,
			modelOptionId: "primary",
			reasoningLevel: "high",
		},
		modelFact: () => ({
			configVersion: "config-a",
			modelOptionId: "primary",
			modelId: model,
			reasoningLevel: "high",
		}),
		runtimeSessionRef: "session-a",
		executionId: "execution-a",
		recordOperationFact: vi.fn(),
		update: vi.fn(),
	};
	const transport = await openRuntimeMessagesTransport({
		readPiSkill: piSessionSkillReader(directory, session, authorize),
		model,
		client: "pi",
		authentication: "bearer",
		effort: "high",
		endpoint: "https://model.example.test",
		openRequest: paseoModelRequest(
			session,
			authorizeModel,
			confirmed,
			async () => {},
		),
		admit: session.admit,
		fetch: upstream,
	});
	try {
		const { executable, cli } = await verifyPiInstallation();
		const { endpoint, credential } = transport.modelAccess;
		await writePiConfiguration(
			config,
			model,
			["high"],
			"high",
			endpoint,
			false,
		);
		const args = await piPodArguments(directory.folders, view);
		const native = promisify(execFile)(
			executable,
			[cli, ...args, "--print", "--no-session", "Write my weekly report."],
			{
				cwd: root,
				env: {
					PATH: process.env.PATH,
					HOME: root,
					PI_OFFLINE: "1",
					PI_CODING_AGENT_DIR: config,
					AGENT_INFRA_PI_MODEL_TOKEN: credential,
					AGENT_INFRA_PI_WORKSPACE: root,
					AGENT_INFRA_PI_SKILL_READER: `${endpoint}/pi/skill-read`,
				},
				timeout: 20_000,
			},
		);
		native.child.stdin?.end();
		expect((await native).stdout.trim()).toBe("本周阻塞");
		expect(upstream).toHaveBeenCalledTimes(2);
		expect(authorizeModel).toHaveBeenCalledTimes(2);
		expect(confirmed).toHaveBeenCalledOnce();
		expect(authorize).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				kind: "tool",
				toolId: "Read",
				executionId: "execution-a",
				nativeSessionRef: "session-a",
			}),
		);
	} finally {
		await transport.close();
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
