import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const source = "a".repeat(40);
const image = `ghcr.io/agoraio-extensions/agent-infra/agent-runtime-codex@sha256:${"b".repeat(64)}`;
const plan = {
	schemaVersion: 1,
	sourceSha: source,
	platform: "linux/amd64",
	groups: [[image]],
};

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "ack-prewarm-cli-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const state = join(root, "state");
	const calls = join(root, "calls");
	const cluster = join(root, "cluster");
	mkdirSync(state, { mode: 0o700 });
	writeFileSync(cluster, JSON.stringify({ items: [] }));
	writeFileSync(
		join(root, "gh"),
		`#!${process.execPath}
const fs=require('node:fs');const path=require('node:path');const a=process.argv.slice(2);
fs.appendFileSync(process.env.CALLS,JSON.stringify(['gh',...a])+'\\n');
const run={databaseId:42,id:42,headSha:'${source}',head_sha:'${source}',attempt:1,run_attempt:1,status:'completed',conclusion:'success',event:'workflow_dispatch',createdAt:'2026-11-05T00:00:00Z',head_branch:'main',path:'.github/workflows/ack-image-cache.yml',repository:{full_name:'AgoraIO-Extensions/agent-infra'},head_repository:{full_name:'AgoraIO-Extensions/agent-infra'}};
if(a[0]==='run'&&a[1]==='list') console.log(JSON.stringify([run]));
else if(a[0]==='run'&&a[1]==='download') { const dir=a[a.indexOf('--dir')+1];fs.writeFileSync(path.join(dir,'cache-plan.json'),process.env.BAD_PLAN?'{}':${JSON.stringify(JSON.stringify(plan))},{flag:'wx'}); }
else if(a[1].includes('/artifacts?')) console.log(JSON.stringify({artifacts:[{id:7,name:'ack-cache-plan-1',expired:false,size_in_bytes:647}]}));
else if(a[1].includes('/git/ref/')) console.log('${source}');
else console.log(JSON.stringify(run));
`,
		{ mode: 0o700 },
	);
	writeFileSync(
		join(root, "kubectl"),
		`#!${process.execPath}
const fs=require('node:fs');const a=process.argv.slice(2);
fs.appendFileSync(process.env.CALLS,JSON.stringify(['kubectl',...a])+'\\n');
if(process.env.KUBE_FAIL){console.error('private credential must not escape');process.exit(1)}
const state=JSON.parse(fs.readFileSync(process.env.CLUSTER,'utf8'));
if(a.includes('create')) {const cr=JSON.parse(fs.readFileSync(0,'utf8')); if(state.items.some(x=>x.metadata.name===cr.metadata.name))process.exit(2);state.items.push({...cr,status:{phase:'Ready',imageCacheId:'imc-test123'}});fs.writeFileSync(process.env.CLUSTER,JSON.stringify(state));}
else if(a.includes('-l')) console.log(JSON.stringify(state));
else {const name=a[a.indexOf('imagecache')+3];const cr=state.items.find(x=>x.metadata.name===name);if(cr)console.log(JSON.stringify(cr));}
`,
		{ mode: 0o700 },
	);
	const env = {
		PATH: root,
		ACK_AUTO_PREWARM_STATE_DIR: state,
		ACK_KUBECONFIG: "/fixture/kubeconfig",
		ACK_NAMESPACE: "fixture",
		CALLS: calls,
		CLUSTER: cluster,
	};
	return {
		state,
		calls,
		cluster,
		run: (overrides = {}) =>
			spawnSync(process.execPath, ["deploy/ack/image-cache-auto-prewarm.ts"], {
				encoding: "utf8",
				timeout: 10000,
				env: { ...env, ...overrides },
			}),
		logs: () =>
			existsSync(calls)
				? readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse)
				: [],
		receipt: () =>
			JSON.parse(
				readFileSync(join(state, "run-42-attempt-1/cache-ready.json")),
			),
	};
}

test("actual poller runs twice in the same directory and reuses live cache", (t) => {
	const f = fixture(t);
	const first = f.run();
	assert.equal(first.status, 0, first.stderr);
	assert.equal(f.receipt().status, "ready");
	const second = f.run();
	assert.equal(second.status, 0, second.stderr);
	assert.equal(f.receipt().status, "ready");
	const calls = f.logs();
	assert.equal(
		calls.filter((a) => a[0] === "kubectl" && a.includes("create")).length,
		1,
	);
	assert.equal(
		calls.filter((a) => a[0] === "gh" && a[1] === "run" && a[2] === "download")
			.length,
		2,
	);
	assert.equal(
		JSON.parse(readFileSync(join(f.state, "last-success.json"))).sourceSha,
		source,
	);
	assert(!existsSync(join(f.state, "prewarm.lock")));
	assert(!readdirSync(f.state).some((x) => x.startsWith("download-")));
});

test("actual poller resumes after Kubernetes failure without losing the plan", (t) => {
	const f = fixture(t);
	const failed = f.run({ KUBE_FAIL: "1" });
	assert.equal(failed.status, 1);
	assert.equal(f.receipt().status, "failed");
	assert.equal(f.receipt().reason, "CACHE_KUBERNETES_REQUEST_FAILED");
	assert(!existsSync(join(f.state, "last-success.json")));
	assert.doesNotMatch(failed.stderr, /private credential/);
	const recovered = f.run();
	assert.equal(recovered.status, 0, recovered.stderr);
	assert.equal(f.receipt().status, "ready");
});

test("invalid download and absent kubeconfig never reach Kubernetes", (t) => {
	const f = fixture(t);
	assert.equal(f.run({ ACK_KUBECONFIG: "" }).status, 1);
	assert.deepEqual(f.logs(), []);
	assert.equal(f.run({ BAD_PLAN: "1" }).status, 1);
	assert.equal(f.logs().filter((a) => a[0] === "kubectl").length, 0);
	assert(!existsSync(join(f.state, "prewarm.lock")));
	assert(!readdirSync(f.state).some((x) => x.startsWith("download-")));
});

test("numeric configuration errors do not reach Kubernetes", (t) => {
	const f = fixture(t);
	for (const setting of [
		"ACK_IMAGE_CACHE_SIZE_GIB",
		"ACK_IMAGE_CACHE_TIMEOUT_MS",
	]) {
		for (const value of ["NaN", "0", "-1", "Infinity"])
			assert.equal(f.run({ [setting]: value }).status, 1);
	}
	assert.equal(f.logs().filter((a) => a[0] === "kubectl").length, 0);
});
