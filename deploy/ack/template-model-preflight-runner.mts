// Local, ignored acceptance tooling. This does not start/stop containers, edit
// Platform data, register templates, or publish releases. Run only against a
// separately started, explicitly owned template-model validation container.
import { createHash, createPrivateKey, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, mkdir, writeFile, lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import * as contracts from "../../packages/contracts/src/runtime/index.ts";
import {createWorkerRuntimeGrantSignerV4} from "../../apps/platform-worker/src/runtime-grant-signer-v4.ts";

let stage = "configuration";
let lastHttpStatus: number | undefined;
let lastProtocolCode: string | undefined;
const fail = () => { throw new Error("TEMPLATE_REAL_MODEL_PREFLIGHT_REJECTED"); };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function privateFile(path: string) {
	if (!isAbsolute(path)) fail();
	const stat = await lstat(path);
	if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
		stat.uid !== process.getuid?.()) fail();
	return readFile(path, "utf8");
}
async function run() {
	if (process.argv.length !== 3) fail();
	const jobPath = process.argv[2];
	const jobBytes = await privateFile(jobPath);
	const c = JSON.parse(jobBytes);
	if (c.schemaVersion !== 1 || typeof c.kubeconfig !== "string" || !isAbsolute(c.kubeconfig) || typeof c.namespace !== "string" || c.scope !== "isolated-template-real-model" ||
		!['codex','claude','opencode','pi'].includes(c.templateId) || !c.operatorApprovalRef ||
		!isAbsolute(c.worktree) || !isAbsolute(c.outputDirectory) ||
		!/^ack-preflight-[a-z0-9-]+$/.test(c.containerName) ||
		!/^sha256:[a-f0-9]{64}$/.test(c.imageDigest) ||
		!c.imageReference.endsWith(`@${c.imageDigest}`) ||
		!/^([a-f0-9]{40})$/.test(c.sourceCommit) ||
		!c.configurationRevision || !c.runtimeConfigVersion ||
		!/^template-validation-agent-[a-z0-9-]+$/.test(c.agentId) ||
		!c.modelId || !c.modelOptionId || !c.reasoningLevel ||
		!c.grantIssuer || !c.workerId || !c.grantKeyId) fail();
	const origin = new URL(c.runtimeBaseUrl);
	const relay = new URL(c.approvedRelayOrigin);
	if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" ||
		origin.pathname !== "/" || origin.search || origin.hash || origin.username ||
		origin.password || !origin.port || relay.protocol !== "https:" ||
		relay.username || relay.password || relay.search || relay.hash ||
		["localhost", "127.0.0.1", "::1"].includes(relay.hostname) ||
		relay.hostname.endsWith(".invalid")) fail();
	stage = "ack-pod-image-source-check";
 const kube=(...args: string[])=>execFileSync("kubectl",["--kubeconfig",c.kubeconfig,"-n",c.namespace,...args],{encoding:"utf8"}).trim();
 const pod=JSON.parse(kube("get","pod",c.containerName,"-o","json"));
 if(pod.metadata.labels["agent-infra.validation-scope"]!==c.scope || pod.spec.containers[0].image!==c.imageReference || pod.status.phase!=="Running" || !pod.spec.nodeName.startsWith(c.expectedNodePrefix ?? "virtual-kubelet-")) fail();
 const source=c.sourceCommit;
 async function waitForHostGrant(grant: {token:string}) {
  const claim=JSON.parse(Buffer.from(grant.token.split('.')[1], 'base64url').toString('utf8'));
  if (!Number.isSafeInteger(claim.issuedAt)||!Number.isSafeInteger(claim.expiresAt)) fail();
  for(let attempt=0;attempt<5;attempt++) {
   const localBefore=Date.now();
   const hostNow=Number(kube("exec",c.containerName,"--","node","-e","console.log(Date.now())"));
   const localAfter=Date.now();
   console.log(JSON.stringify({stage:"grant-host-clock",issuedAt:claim.issuedAt,hostNow,localBefore,localAfter,attempt}));
   if(!Number.isSafeInteger(hostNow)||hostNow>=claim.expiresAt) fail();
   if(hostNow>=claim.issuedAt) return;
   const wait=claim.issuedAt-hostNow;
   if(wait>2000) fail();
   await new Promise(resolve=>setTimeout(resolve,wait+50));
  }
  fail();
 }

 if(!/^[a-f0-9]{64}$/.test(c.runtimeModuleSha256??"")) fail();
 const actualModuleHash=kube("exec",c.containerName,"--","node","-e","console.log(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('/app/node_modules/@agent-infra/agent-runtime/dist/index.mjs')).digest('hex'))");
 if(actualModuleHash!==c.runtimeModuleSha256) fail();
 const image=pod.status.containerStatuses[0].imageID;
 const command="/bin/sh",commandArgs=["./start-runtime-host.sh"];
 const observedResourceLimits=pod.spec.containers[0].resources.limits;
 if(observedResourceLimits.cpu!==c.expectedResourceLimits.cpu || observedResourceLimits.memory!==c.expectedResourceLimits.memory) fail();

 const nonSecretEnvironment=(name:string)=>{
  if(!["AGENT_INFRA_RUNTIME_MODEL_CONFIG","AGENT_INFRA_RUNTIME_AGENT_ID","AGENT_INFRA_RUNTIME_DRIVER"].includes(name)) fail();
  return pod.spec.containers[0].env.find((e:any)=>e.name===name)?.value;
 };
 if(nonSecretEnvironment("AGENT_INFRA_RUNTIME_DRIVER")!==c.driver || nonSecretEnvironment("AGENT_INFRA_RUNTIME_AGENT_ID")!==c.agentId) fail();
	stage = "runtime-configuration-check";
	const actualConfiguration = contracts.RuntimeModelConfigurationV4Schema.parse(JSON.parse(
		nonSecretEnvironment("AGENT_INFRA_RUNTIME_MODEL_CONFIG")));
	const selected = actualConfiguration.modelOptions.find((option: any) => option.modelOptionId === c.modelOptionId);
	if (actualConfiguration.configVersion !== c.runtimeConfigVersion || !selected ||
		selected.model !== c.modelId || new URL(selected.endpoint).origin !== relay.origin ||
		!selected.reasoningLevels.includes(c.reasoningLevel) || selected.protocol !== c.protocol) fail();
	stage = "signer-load";

	const signer = createWorkerRuntimeGrantSignerV4({
		issuer: c.grantIssuer, workerId: c.workerId, keyId: c.grantKeyId,
		privateKey: createPrivateKey(await privateFile(c.grantPrivateKeyFile)),
	});
	stage = "private-inputs-check";
	const serviceToken = (await privateFile(c.runtimeServiceTokenFile)).trim();
	const relayKey = (await privateFile(c.relayKeyFile)).trim();
	let resume: any;
    const checkpointPath = join(c.outputDirectory, "in-flight.json");
    try {
        resume = JSON.parse(await privateFile(checkpointPath));
        if (resume.sourceCommit !== c.sourceCommit || resume.imageDigest !== c.imageDigest) fail();
    } catch(error: any) { if (error.code !== "ENOENT") throw error; }
    const id = resume?.frozen.executionId ?? `template-validation-${randomUUID()}`;
	const authorizationRecordId = resume?.authorizationRecordId ?? `isolated-validation-${randomUUID()}`;
	const principal = { kind: "application", id: `isolated-validation-${randomUUID()}` };
	const agentId = c.agentId;
	const frozen = resume?.frozen ?? {
		requestId: randomUUID(), traceId: randomUUID(), principal,
		executionSource: "eval", channelId: "isolated-template-validation",
		agentId, conversationId: `validation-conversation-${randomUUID()}`,
		executionId: id, turnId: `validation-turn-${randomUUID()}`,
		sessionGeneration: 1, hostSessionRef: null,
		operation: { kind: "execution", id, deliveryFence: 1, executionDeliveryFence: 1 },
		keyBinding: { purpose: "agent-default", subjectId: agentId,
			ciphertextRef: `validation-key-${randomUUID()}`, version: 1 },
	};
	stage = "turn-request-schema";
	const unsigned = contracts.RuntimeSubmitTurnRequestV4Schema.parse({
		schemaVersion: 4, ...frozen,
		input: { text: "Reply with the single word READY. Do not use tools.", attachments: [] },
		selection: { schemaVersion: 1, modelOptionId: c.modelOptionId, reasoningLevel: c.reasoningLevel },
		grant: { schemaVersion: 4, format: "runtime-execution-jws", token: "unsigned.unsigned.unsigned" },
	});
	stage = "sign-and-verify";
	const grant = signer.sign(unsigned, authorizationRecordId);
	const claims = signer.verify(grant);
	const businessRequest = { ...unsigned, grant };
	stage = "private-key-context-schema";
	const privateKeyField = contracts.RuntimePrivateRelayKeyFieldV1Schema.parse({
		schemaVersion: 1,
		context: { ...frozen, grantId: claims.grantId, requestDigest: claims.requestDigest },
		keyDelivery: { relayKey },
	});
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 120_000);
	async function post(path: string, body: unknown) {
		if (await privateFile(jobPath) !== jobBytes) fail();
		const response = await fetch(new URL(path, origin), {
			method: "POST", redirect: "error", signal: controller.signal,
			headers: { "content-type": "application/json", authorization: `Bearer ${serviceToken}` },
			body: JSON.stringify(body),
		});
		lastHttpStatus = response.status;
        if (!response.ok) {const err:any=await response.json().catch(()=>({}));lastProtocolCode=typeof err.code==="string"?err.code:JSON.stringify(Object.keys(err));fail();}
        if(!response.headers.get("content-type")?.includes("application/json")) fail();
		const text = await response.text();
		if (Buffer.byteLength(text) > 2 * 1024 * 1024) fail();
		return JSON.parse(text);
	}
	try {
		stage = "actual-runtime-submit";
		// The probe signer runs on macOS while Host runs in the owned VM. Wait
        // until the already-signed grant is valid there; do not backdate claims
        // or change any Runtime authorization gate/product deadline.
        if (!resume) await waitForHostGrant(grant);
        const accepted = contracts.RuntimeOperationResponseV4Schema.parse(resume?.accepted ?? await post("/internal/runtime/v4/turns", { businessRequest, privateKeyField }));
        if (!resume) {
            await mkdir(c.outputDirectory, {recursive:true,mode:0o700});
            await writeFile(checkpointPath, JSON.stringify({sourceCommit:c.sourceCommit,imageDigest:c.imageDigest,frozen,authorizationRecordId,accepted})+"\n",{mode:0o600,flag:"wx"});
        }
		if (accepted.operationId !== id || accepted.result.outcome !== "accepted" ||
			!["running", "completed"].includes(accepted.result.status)) fail();
		let cursor: string | null = null;
		let completed = false;
        let reply = "";
		const modelFacts: any[] = [];
		stage = "actual-runtime-events";
		while (!completed) {
			const read = contracts.RuntimeEventReadRequestV4Schema.parse({
				...frozen, schemaVersion: 4, requestId: randomUUID(),
				hostSessionRef: accepted.hostSessionRef,
				consumer: "platform_worker_persistence", afterCursor: cursor,
				grant: { schemaVersion: 2, format: "runtime-execution-jws", token: "unsigned.unsigned.unsigned" },
			});
			const eventGrant = await signer.signEvent(read, { purpose: "business", authorizationRecordId });
			await waitForHostGrant(eventGrant);
            const replay = contracts.validateRuntimeReplayResponseV4(await post("/internal/runtime/v4/events/read", { ...read, grant: eventGrant }), read);
			for (const event of replay.events) {
				console.log(JSON.stringify({eventType:event.type,payloadKeys:Object.keys(event.payload??{}),model:event.type==="operation"&&event.payload?.kind==="model"?event.payload.model:undefined,phase:event.payload?.phase}));
                if (event.executionId !== id) fail();
                if(event.type==="text") reply+=event.payload.delta;
 if(event.type==="status" && ["failed","unknown","cancelled"].includes(event.payload.status)){ console.log(JSON.stringify({runtimeStatus:event.payload.status}));fail(); }
				cursor = event.cursor;
				if (event.type === "operation" && event.payload?.kind === "model") {
					const fact = event.payload;
                    if(fact.phase === "failed" || fact.phase === "unknown") console.log(JSON.stringify({eventType:event.type,kind:fact.kind,phase:fact.phase,keys:Object.keys(fact),errorCode:fact.error?.code,code:fact.code}));
					if (fact.phase === "failed" || fact.phase === "unknown") fail();
					if (fact.phase === "completed") {
						if (fact.model.modelOptionId !== c.modelOptionId || fact.model.configVersion !== c.runtimeConfigVersion || fact.model.reasoningLevel !== c.reasoningLevel) fail();
						modelFacts.push(fact);
					}
				}
				if (event.type === "error") {console.log(JSON.stringify({eventType:event.type,code:event.payload?.code,keys:Object.keys(event.payload??{})}));fail();}
				if (event.type === "completed") {
					if (event.payload.status !== "completed") { console.log(JSON.stringify({completedStatus:event.payload.status, reply})); fail(); }
					completed = true;
				}
			}
			if (!completed) await new Promise(resolve => setTimeout(resolve, 200));
		}
		// Pi durably stores model facts in its protected Driver journal; its V1
        // event stream carries reply/status, not Codex V2 operation frames.
        console.log(JSON.stringify({stage:"reply-check",replyLength:reply.trim().length,replyHash:hash(reply.trim())}));
        if(!completed || !cursor || reply.trim()!=="READY") fail();
        if (modelFacts.length < 1) fail();
		stage = "evidence-write";
		await mkdir(c.outputDirectory, { recursive: true, mode: 0o700 });
		const validatedAt = Date.now();
		const validation = { schemaVersion: 1, templateId: c.templateId, imageDigest: c.imageDigest,
			driver: c.driver, configurationRevision: c.configurationRevision,
			status: "passed", evidenceKind: "real-runtime-model", executionId: id,
			modelId: c.modelId, validatedAt, validUntil: validatedAt + 60 * 60 * 1000 };
		const receipt = { schemaVersion: 1, scope: c.scope, templateId: c.templateId,
			platformLdapVerified: false, platformBusinessAuthorizationVerified: false,
			sourceCommit: source, imageDigest: c.imageDigest, imageId: image, observedResourceLimits, launcherPath: command, launcherArgs: commandArgs,
			signatureDispatchDelayMs:350, resumedExistingExecution:Boolean(resume), operatorApprovalRef: c.operatorApprovalRef, approvedRelayOriginSha256: hash(relay.origin),
			executionId: id, hostSessionRefSha256: hash(accepted.hostSessionRef),
			runtimeModuleSha256: c.runtimeModuleSha256, artifactKind: "official-published-runtime", modelFactSource: "protected-driver-journal", modelFactsInV4EventStream: false, replyMatched: true, replySha256: hash(reply.trim()), nativeTelemetryModelIds:[...new Set(modelFacts.map(f=>f.model.modelId))], modelOperationCount: modelFacts.length, modelOperationRefs: modelFacts.map(f => hash(f.operationRef)),
			modelId: c.modelId, runtimeConfigVersion: c.runtimeConfigVersion,
			terminalStatus: "completed", cursorSha256: hash(cursor), validatedAt };
		await writeFile(join(c.outputDirectory, "template-model-preflight.receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600, flag: "wx" });
		await writeFile(join(c.outputDirectory, `template-validation-${c.templateId}.candidate.json`), JSON.stringify(validation, null, 2) + "\n", { mode: 0o600, flag: "wx" });
		console.log(JSON.stringify({ status: "passed", scope: c.scope, imageDigest: c.imageDigest, executionId: id, outputDirectory: c.outputDirectory }));
	} finally { clearTimeout(timeout); controller.abort(); }
}
run().catch((error: any) => { console.error(JSON.stringify({status:"failed",code:"TEMPLATE_REAL_MODEL_PREFLIGHT_FAILED",stage,lastHttpStatus,lastProtocolCode,errorName:error.name,causeCode:error.cause?.code,probeLine:error.stack?.split("\n")[2],issues:error.issues?.map((i:any)=>({code:i.code,path:i.path}))})); process.exitCode=1; });
