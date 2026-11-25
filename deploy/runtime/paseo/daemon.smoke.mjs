import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { get } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";

const home = await mkdtemp("/tmp/paseo-image-");
const socketPath = join(home, "control.sock");

async function status(password) {
	return new Promise((resolve, reject) => {
		const request = get(
			{
				socketPath,
				path: "/api/status",
				headers: { authorization: "Bearer " + password },
			},
			async (response) => {
				try {
					let body = "";
					for await (const chunk of response) body += chunk;
					resolve({ code: response.statusCode, result: JSON.parse(body) });
				} catch (error) {
					reject(error);
				}
			},
		);
		request.once("error", reject);
	});
}

async function run(password, previousPassword) {
	const child = spawn(process.execPath, [process.argv[2]], {
		env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home, PASEO_HOME: home },
		stdio: ["pipe", "pipe", "inherit"],
	});
	const closed = once(child, "close");
	const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
	try {
		const output = createInterface({ input: child.stdout });
		child.stdin.write(
			JSON.stringify({
				home,
				socketPath,
				password,
				provider: "pi",
				command: ["/bin/true"],
				env: {},
			}) + "\n",
		);
		let ready = false;
		for await (const line of output) {
			if (line === "AGENT_INFRA_PASEO_READY") {
				ready = true;
				break;
			}
		}
		assert.equal(ready, true);
		if (previousPassword)
			assert.equal((await status(previousPassword)).code, 401);
		const current = await status(password);
		assert.equal(current.code, 200);
		assert.equal(typeof current.result.serverId, "string");
		child.stdin.end();
		assert.deepEqual(await closed, [0, null]);
		return current.result.serverId;
	} finally {
		clearTimeout(timer);
		if (child.exitCode === null && child.signalCode === null)
			child.kill("SIGKILL");
		await closed;
	}
}

try {
	const firstPassword = randomUUID();
	const serverId = await run(firstPassword);
	assert.equal(await run(randomUUID(), firstPassword), serverId);
} finally {
	await rm(home, { recursive: true, force: true });
}
