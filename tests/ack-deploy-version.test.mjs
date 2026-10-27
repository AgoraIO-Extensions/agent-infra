import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const kubectl = spawnSync("which", ["kubectl"], {
	encoding: "utf8",
}).stdout.trim();
const script = new URL("../deploy/ack/deploy.sh", import.meta.url).pathname;

for (const [name, version, expected] of [
	["stable", "v1.36.1", "1.36.1"],
	["vendor build", "v1.36.1+vendor.2", "1.36.1+vendor.2"],
	["prerelease", "v1.36.0-rc.1", "1.36.0-rc.1"],
	["missing", undefined, null],
	["malformed", "v1.36.1+bad space", null],
	["unavailable", "http-error", null],
]) {
	test(`ACK deploy reads real kubectl JSON: ${name}`, async () => {
		assert.ok(kubectl, "kubectl is required for CLI compatibility validation");
		const directory = await mkdtemp(join(tmpdir(), "ack-version-"));
		const server = createServer((request, response) => {
			assert.equal(
				new URL(request.url, "http://localhost").pathname,
				"/version",
			);
			response.setHeader("Content-Type", "application/json");
			response.statusCode = version === "http-error" ? 503 : 200;
			response.end(
				JSON.stringify({ major: "1", minor: "36", gitVersion: version }),
			);
		});
		try {
			await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
			const config = join(directory, "config");
			const values = join(directory, "values.yaml");
			const log = join(directory, "calls.jsonl");
			await writeFile(
				config,
				JSON.stringify({
					apiVersion: "v1",
					kind: "Config",
					clusters: [
						{
							name: "test",
							cluster: { server: `http://127.0.0.1:${server.address().port}` },
						},
					],
					contexts: [{ name: "test", context: { cluster: "test" } }],
					"current-context": "test",
				}),
			);
			await writeFile(values, "{}");
			await writeFile(
				join(directory, "kubectl"),
				`#!${process.execPath}
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({tool:'kubectl',args,config:process.env.KUBECONFIG})+'\\n');
if(args.includes('version')) {
 const result=spawnSync(${JSON.stringify(kubectl)},args,{stdio:'inherit'});
 process.exit(result.status ?? 1);
}
`,
				{ mode: 0o700 },
			);
			await writeFile(
				join(directory, "helm"),
				`#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({tool:'helm',args,config:process.env.KUBECONFIG})+'\\n');
if(args[0]==='template') process.stdout.write('kind: ConfigMap\\n');
`,
				{ mode: 0o700 },
			);
			const child = spawn("bash", [script], {
				env: {
					...process.env,
					PATH: `${directory}:${process.env.PATH}`,
					ACK_KUBECONFIG: config,
					KUBECONFIG: join(directory, "wrong-config"),
					ACK_VALUES_FILE: values,
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stderr = "";
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			child.stdout.resume();
			const code = await new Promise((resolve, reject) => {
				child.once("error", reject);
				child.once("close", resolve);
			});
			const calls = (await readFile(log, "utf8"))
				.trim()
				.split("\n")
				.map(JSON.parse);
			if (expected === null) {
				assert.notEqual(code, 0);
				assert.match(stderr, /Unable to read Kubernetes|invalid Kubernetes/);
				assert.equal(
					calls.some((call) => call.tool === "helm"),
					false,
				);
			} else {
				assert.equal(code, 0, stderr);
				const render = calls.find(
					(call) => call.tool === "helm" && call.args[0] === "template",
				);
				assert.equal(
					render.args[render.args.indexOf("--kube-version") + 1],
					expected,
				);
				const upgrade = calls.find(
					(call) => call.tool === "helm" && call.args[0] === "upgrade",
				);
				assert.equal(upgrade.config, config);
			}
		} finally {
			await new Promise((resolve) => server.close(resolve));
			await rm(directory, { recursive: true, force: true });
		}
	});
}
