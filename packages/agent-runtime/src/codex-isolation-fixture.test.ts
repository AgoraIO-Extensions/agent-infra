import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	CODEX_ISOLATION_PERSISTENCE_EVIDENCE,
	evaluatePersistenceEvidence,
	type IsolationProbe,
	isolationActiveThreadEvidenceStatus,
	isolationModel,
	isolationOverallStatus,
	isolationResultSeesMarker,
	isolationScenarioStatus,
	nativeIsolationLauncher,
	nativeLaunchDirectoryRelations,
} from "./codex-isolation.test-support.js";

const servers: Awaited<ReturnType<typeof isolationModel>>[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function model() {
	const server = await isolationModel();
	servers.push(server);
	return server;
}

async function submit(
	server: Awaited<ReturnType<typeof isolationModel>>,
	probe: IsolationProbe,
	input: unknown[] = [],
	tools: unknown[] = [],
) {
	const response = await fetch(`${server.url}/responses`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			input: [
				{
					role: "user",
					content: [
						{ type: "input_text", text: `ISOLATION_PROBE:${probe.id}` },
					],
				},
				...input,
			],
			tools,
		}),
	});
	return { status: response.status, body: await response.text() };
}

it("never copies one probe's synthetic context to the other model response", async () => {
	const server = await model();
	const first = server.probe();
	const second = server.probe();
	server.synchronize([first, second]);
	const responses = await Promise.all([
		submit(server, first, [
			{ role: "assistant", content: [{ text: "SYNTH_CONTEXT_A_PRIVATE" }] },
		]),
		submit(server, second),
	]);
	expect(responses.map((response) => response.status)).toEqual([200, 200]);
	expect(first.answer).toContain("SYNTH_CONTEXT_A_PRIVATE");
	expect(second.answer).toBe("NO_CONTEXT_MARKER");
	expect(second.inputs.join("")).not.toContain("SYNTH_CONTEXT_A_PRIVATE");
	expect(first.concurrent && second.concurrent).toBe(true);
});

it("detects foreign markers in every model and platform result channel", () => {
	const marker = "SYNTH_FOREIGN_MARKER";
	const base = {
		inputs: [],
		outputs: [],
		answer: "",
		events: "",
	};
	for (const result of [
		{ ...base, outputs: [marker] },
		{ ...base, answer: marker },
	]) {
		const foreignMarkerObserved = isolationResultSeesMarker({
			probe: result,
			events: result.events,
			marker,
		});
		expect(foreignMarkerObserved).toBe(true);
		const scenarioStatus = isolationScenarioStatus({
			foreignMarkerObserved,
			positiveControl: true,
			completeOutput: true,
		});
		expect(scenarioStatus).toBe("fail");
		expect(
			isolationOverallStatus({
				activeThreadLeak: false,
				persistenceVerified: true,
				scenarioStatuses: ["pass", scenarioStatus],
			}),
		).toBe("fail");
	}
});

it("requires complete active-thread evidence for an isolation pass", () => {
	expect(
		isolationActiveThreadEvidenceStatus({
			activeThreadLeak: true,
			pointEvidence: [true, true],
		}),
	).toBe("fail");
	expect(
		isolationActiveThreadEvidenceStatus({
			activeThreadLeak: false,
			pointEvidence: [true, true],
		}),
	).toBe("pass");
	expect(
		isolationActiveThreadEvidenceStatus({
			activeThreadLeak: false,
			pointEvidence: [true, false],
		}),
	).toBe("unverified");
});

it("returns the native tool output only after the matching tool call completes", async () => {
	const server = await model();
	const probe = server.probe("cat synthetic-private.txt");
	const tools = [{ type: "function", name: "exec_command" }];
	const call = await submit(server, probe, [], tools);
	expect(call.status).toBe(200);
	expect(call.body).toContain("function_call");
	expect(probe.outputs).toEqual([]);
	expect(probe.answer).toBe("");
	const complete = await submit(
		server,
		probe,
		[
			{
				type: "function_call_output",
				call_id: probe.id,
				output: "SYNTH_PRIVATE_FROM_NATIVE_TOOL",
			},
		],
		tools,
	);
	expect(complete.status).toBe(200);
	expect(probe.outputs).toEqual(['"SYNTH_PRIVATE_FROM_NATIVE_TOOL"']);
	expect(complete.body).toContain("SYNTH_PRIVATE_FROM_NATIVE_TOOL");
});

it("fails the model probe when native command tools are unavailable", async () => {
	const server = await model();
	const probe = server.probe("cat synthetic-private.txt");
	expect((await submit(server, probe)).status).toBe(500);
	expect(probe.outputs).toEqual([]);
	expect(probe.answer).toBe("");
});

it("holds synthetic request observation and response at separate probe points", async () => {
	const server = await model();
	const probe = server.probe();
	const hold = server.holdObservation(probe);
	const response = submit(server, probe);
	await hold.received;
	expect(probe.inputs).toEqual([]);
	hold.allowObservation();
	await hold.observed;
	expect(probe.inputs).toHaveLength(1);
	hold.releaseResponse();
	await hold.responseSent;
	expect((await response).status).toBe(200);
});

it("retries pre-launch and incomplete native observation reads", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-runtime-observation-"));
	try {
		const launcher = await nativeIsolationLauncher(
			directory,
			process.execPath,
			"http://127.0.0.1:1/v1",
		);
		const observationFile = join(directory, "observations.jsonl");
		await expect(launcher.observations()).rejects.toMatchObject({
			category: "missing",
		});
		const preLaunch = launcher.observations({ allowEmptyBeforeLaunch: true });
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
		await writeFile(observationFile, '{"method":"launch"}\n');
		await expect(preLaunch).resolves.toEqual([{ method: "launch" }]);
		await writeFile(observationFile, '{"method":"launch"}');
		const snapshot = launcher.observations();
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
		await appendFile(observationFile, "\n");
		await expect(snapshot).resolves.toEqual([{ method: "launch" }]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("binds a final isolation result to the exact clean #403 merge", () => {
	const { mergeCommit } = CODEX_ISOLATION_PERSISTENCE_EVIDENCE;
	expect(
		evaluatePersistenceEvidence({
			requiredCommit: mergeCommit,
			requiredCommitReachable: true,
			workingTreeClean: true,
		}),
	).toMatchObject({
		status: "pass",
		reason: "required-403-merge-reachable-clean-head",
	});
});

it("reports terminal native observation failures without treating them as empty", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-runtime-observation-"));
	try {
		const launcher = await nativeIsolationLauncher(
			directory,
			process.execPath,
			"http://127.0.0.1:1/v1",
		);
		const observationFile = join(directory, "observations.jsonl");
		await writeFile(observationFile, "");
		await expect(launcher.observations()).rejects.toMatchObject({
			category: "empty",
		});
		await writeFile(observationFile, '{"method":"launch"}');
		await expect(launcher.observations()).rejects.toMatchObject({
			category: "incomplete",
		});
		await writeFile(observationFile, "not-json\n");
		await expect(launcher.observations()).rejects.toMatchObject({
			category: "invalid-json",
		});
		await rm(observationFile);
		await mkdir(observationFile);
		await expect(launcher.observations()).rejects.toMatchObject({
			category: "read-error",
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("rejects overlapping synthetic launch directories", () => {
	expect(
		nativeLaunchDirectoryRelations({
			home: "/synthetic/home",
			codexHome: "/synthetic/codex-home",
			cwd: "/synthetic/workspace",
		}),
	).toMatchObject({ isolated: true });
	expect(
		nativeLaunchDirectoryRelations({
			home: "/synthetic/workspace",
			codexHome: "/synthetic/codex-home",
			cwd: "/synthetic/workspace",
		}),
	).toMatchObject({ homeEqualsCwd: true, isolated: false });
	expect(
		nativeLaunchDirectoryRelations({
			home: "/synthetic/home",
			codexHome: "/synthetic/workspace",
			cwd: "/synthetic/workspace",
		}),
	).toMatchObject({ codexHomeEqualsCwd: true, isolated: false });
	expect(
		nativeLaunchDirectoryRelations({
			home: "/synthetic/codex-home",
			codexHome: "/synthetic/codex-home",
			cwd: "/synthetic/workspace",
		}),
	).toMatchObject({ homeEqualsCodexHome: true, isolated: false });
	expect(
		nativeLaunchDirectoryRelations({
			home: "/synthetic/home",
			codexHome: "/synthetic/codex-home",
			cwd: "/synthetic/home/workspace",
		}),
	).toMatchObject({ homeOverlapsCwd: true, isolated: false });
	expect(
		nativeLaunchDirectoryRelations({
			home: "/synthetic/home",
			codexHome: "/synthetic/workspace/.codex-home",
			cwd: "/synthetic/workspace",
		}),
	).toMatchObject({ codexHomeOverlapsCwd: true, isolated: false });
	expect(
		nativeLaunchDirectoryRelations({
			home: "/synthetic/home/codex-home",
			codexHome: "/synthetic/home",
			cwd: "/synthetic/workspace",
		}),
	).toMatchObject({ homeOverlapsCodexHome: true, isolated: false });
});

it("rejects unrelated, missing, and dirty persistence evidence", () => {
	const { mergeCommit } = CODEX_ISOLATION_PERSISTENCE_EVIDENCE;
	expect(
		evaluatePersistenceEvidence({
			requiredCommit: "4e6e1fa456f1712b81d9cc4ac4ad765106ecd811",
			requiredCommitReachable: true,
			workingTreeClean: true,
		}),
	).toMatchObject({
		status: "unverified",
		reason: "unexpected-persistence-commit",
	});
	expect(
		evaluatePersistenceEvidence({
			requiredCommit: mergeCommit,
			requiredCommitReachable: false,
			workingTreeClean: true,
		}),
	).toMatchObject({
		status: "unverified",
		reason: "required-403-merge-not-reachable",
	});
	expect(
		evaluatePersistenceEvidence({
			requiredCommit: mergeCommit,
			requiredCommitReachable: true,
			workingTreeClean: false,
		}),
	).toMatchObject({
		status: "unverified",
		reason: "acceptance-worktree-dirty",
	});
});
