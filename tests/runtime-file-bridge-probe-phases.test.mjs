/**
 * #3230：FileBridge 探针阶段边界的真实进程回归。入口是真实的 Node 进程树：它监听阶段
 * 端口，并像 runner 一样把原生子进程放在自己的会话与进程组中。读取 Linux /proc，
 * 其他平台跳过。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createProbeProcesses } from "./support/runtime-file-bridge-probe.mjs";

const skip =
	!existsSync("/proc/self/stat") &&
	"the phase boundary reads the Linux /proc process table";

// clean: the runner signals the native process group and exits after it.
// leak: the native ignores SIGTERM and the Host exits without waiting for it.
// hang: the Host ignores SIGTERM.
// next: records that it started.
// The Host reports ready only after the native child has installed its handler.
const hostEntry = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
const [mode, port, marker] = process.argv.slice(2);
if (mode === "next") writeFileSync(marker, "started\\n");
const native = spawn(process.execPath, ["-e", (mode === "leak" ? "process.on('SIGTERM', () => {});" : "") + "console.log('ready'); setInterval(() => {}, 1000);"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
let server;
process.on("SIGTERM", () => {
	if (mode === "hang") return;
	try { process.kill(-native.pid, "SIGTERM"); } catch {}
	const exit = () => server.close(() => process.exit(0));
	if (mode === "leak") exit();
	else native.once("exit", exit);
});
native.stdout.once("data", () => {
	server = createServer().listen(Number(port), "127.0.0.1", () =>
		console.log(JSON.stringify({ status: "ready", native: native.pid })));
});
`;

function stat(pid) {
	try {
		const text = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
		return {
			state: fields[0],
			pgrp: Number(fields[2]),
			session: Number(fields[3]),
		};
	} catch {
		return undefined;
	}
}

const alive = (pid) => {
	const state = stat(pid)?.state;
	return state !== undefined && state !== "Z" && state !== "X";
};

async function freePort() {
	const server = createServer();
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	await new Promise((resolve) => server.close(resolve));
	return port;
}

const accepts = (port) =>
	new Promise((resolve) => {
		const socket = connect({ host: "127.0.0.1", port });
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});

function fixture(t) {
	const directory = mkdtempSync(join(tmpdir(), "file-bridge-phases-"));
	writeFileSync(join(directory, "host.mjs"), hostEntry);
	const processes = createProbeProcesses({
		command: process.execPath,
		entry: join(directory, "host.mjs"),
		cwd: directory,
	});
	t.after(() => {
		processes.killAll();
		rmSync(directory, { recursive: true, force: true });
	});
	const marker = join(directory, "next-phase-started");
	return {
		processes,
		marker,
		async start(mode) {
			const port = await freePort();
			const phase = processes.spawn([mode, String(port), marker], {
				PATH: process.env.PATH,
			});
			const deadline = Date.now() + 10_000;
			for (;;) {
				const ready = phase.record.output
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line))
					.find((line) => line.status === "ready");
				if (ready) return { phase, port, native: ready.native };
				assert.ok(Date.now() < deadline, "fixture Host did not start");
				await delay(25);
			}
		},
	};
}

// The probe's later phase is the next spawn; it must not start at all.
async function assertNextPhaseRefused({ processes, marker }, failure) {
	const port = await freePort();
	assert.throws(
		() =>
			processes.spawn(["next", String(port), marker], {
				PATH: process.env.PATH,
			}),
		(error) => error === failure,
	);
	await delay(300);
	assert.equal(existsSync(marker), false);
	assert.equal(await accepts(port), false);
}

test("a phase ends only after its whole tree, native process groups included, is gone", {
	skip,
}, async (t) => {
	const probe = fixture(t);
	const { phase, port, native } = await probe.start("clean");
	// The native child runs in its own session and process group, so the
	// entry's negative PID does not reach it.
	assert.equal(stat(native).pgrp, native);
	assert.equal(stat(native).session, native);
	assert.notEqual(stat(native).pgrp, stat(phase.child.pid).pgrp);
	assert.equal(await accepts(port), true);
	assert.equal(
		await probe.processes.settle(phase, {
			name: "runtime",
			signal: "SIGTERM",
			ports: [port],
		}),
		0,
	);
	assert.equal(alive(phase.child.pid), false);
	assert.equal(alive(native), false);
	assert.equal(await accepts(port), false);
	// A proven boundary lets the next phase start.
	const next = await probe.start("next");
	assert.equal(existsSync(probe.marker), true);
	await probe.processes.settle(next.phase, {
		name: "next",
		signal: "SIGTERM",
		ports: [next.port],
	});
});

test("a native child that outlives its Host fails the phase after confirmed forced cleanup", {
	skip,
}, async (t) => {
	const probe = fixture(t);
	const { phase, port, native } = await probe.start("leak");
	const started = Date.now();
	const failure = await probe.processes
		.settle(phase, {
			name: "runtime",
			signal: "SIGTERM",
			ports: [port],
			graceMs: 1_500,
			forceMs: 5_000,
		})
		.then(
			() => assert.fail("an unproven phase passed"),
			(error) => error,
		);
	assert.match(
		failure.message,
		/^runtime did not terminate within 1500 ms; forced cleanup confirmed$/,
	);
	assert.ok(Date.now() - started >= 1_500);
	// The Host exited normally; only the force reached the native child.
	assert.equal(phase.code, 0);
	assert.equal(alive(native), false);
	assert.equal(await accepts(port), false);
	await assertNextPhaseRefused(probe, failure);
});

test("a Host that ignores SIGTERM times out, is force-killed and never passes", {
	skip,
}, async (t) => {
	const probe = fixture(t);
	const { phase, port, native } = await probe.start("hang");
	const failure = await probe.processes
		.settle(phase, {
			name: "runtime",
			signal: "SIGTERM",
			ports: [port],
			graceMs: 1_000,
			forceMs: 5_000,
		})
		.then(
			() => assert.fail("a timed-out phase passed"),
			(error) => error,
		);
	assert.match(failure.message, /did not terminate within 1000 ms; forced/);
	assert.equal(phase.code, null);
	assert.equal(alive(phase.child.pid), false);
	assert.equal(alive(native), false);
	assert.equal(await accepts(port), false);
	await assertNextPhaseRefused(probe, failure);
});

test("a phase port served outside the tracked tree fails the boundary", {
	skip,
}, async (t) => {
	const probe = fixture(t);
	const held = await freePort();
	// A real process that is not a descendant of the entry holds the port.
	const holder = spawn(
		process.execPath,
		[
			"-e",
			`require("node:net").createServer().listen(${held}, "127.0.0.1", () => console.log("ready"))`,
		],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);
	t.after(() => holder.kill("SIGKILL"));
	await new Promise((resolve) => holder.stdout.once("data", resolve));
	const { phase, port, native } = await probe.start("clean");
	const failure = await probe.processes
		.settle(phase, {
			name: "runtime",
			signal: "SIGTERM",
			ports: [port, held],
		})
		.then(
			() => assert.fail("a served port passed"),
			(error) => error,
		);
	assert.equal(
		failure.message,
		`runtime port ${held} still accepts connections`,
	);
	// The tree itself terminated; the port is the unproven part.
	assert.equal(alive(phase.child.pid), false);
	assert.equal(alive(native), false);
	assert.equal(await accepts(port), false);
	await assertNextPhaseRefused(probe, failure);
});
