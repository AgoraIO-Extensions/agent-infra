import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
	lstat,
	mkdir,
	readFile,
	realpath,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { privateBytes } from "./private-input.ts";
import { createCustomCapacityKubernetes } from "./custom-capacity-kubernetes.mts";
import {
	CUSTOM_CAPACITY_SCOPE,
	capacityProfile,
	customCapacityJobDefinitionHash,
	evidenceBytes,
	sha256,
	validateCustomCapacityJob,
	validateCustomEnvironment,
	verifyCustomImageEvidence,
	type CustomCapacityJob,
} from "./custom-capacity-inputs.mts";
export * from "./custom-capacity-inputs.mts";

const toolsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeModulePath =
	"/app/node_modules/@agent-infra/agent-runtime/dist/index.mjs";
const toolFiles = [
	"deploy/ack/custom-model-preflight.mts",
	"deploy/ack/custom-capacity-inputs.mts",
	"deploy/ack/custom-capacity-kubernetes.mts",
	"deploy/ack/custom-capacity-runtime.mts",
	"deploy/ack/custom-capacity-register.mts",
	"apps/platform-worker/src/runtime-grant-signer.ts",
	"apps/platform-worker/src/runtime-host-client.ts",
	"pnpm-lock.yaml",
];
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		timeout: 10_000,
		maxBuffer: 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
const readJson = (bytes: Uint8Array) =>
	JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));

async function identities(job: CustomCapacityJob) {
	const applicationRoot = await realpath(job.sourceWorktree);
	assert(
		git(applicationRoot, "rev-parse", "--show-toplevel") === applicationRoot,
		"CUSTOM_CAPACITY_SOURCE_ROOT_INVALID",
	);
	assert(
		git(applicationRoot, "rev-parse", "HEAD") === job.sourceCommit &&
			git(applicationRoot, "status", "--porcelain", "--untracked-files=all") ===
				"",
		"CUSTOM_CAPACITY_SOURCE_DRIFT",
	);
	assert(
		git(
			applicationRoot,
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		) ===
			git(toolsRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"),
		"CUSTOM_CAPACITY_FOREIGN_SOURCE",
	);
	const toolingRevision = git(toolsRoot, "rev-parse", "HEAD");
	assert(
		git(toolsRoot, "status", "--porcelain", "--untracked-files=all") === "",
		"CUSTOM_CAPACITY_TOOLING_DIRTY",
	);
	const files: Record<string, string> = {};
	for (const file of toolFiles) {
		git(toolsRoot, "ls-files", "--error-unmatch", file);
		files[file] = sha256(await readFile(join(toolsRoot, file)));
	}
	return { applicationSource: job.sourceCommit, toolingRevision, files };
}

/** Bundle the existing source client/signer instead of maintaining a second wire protocol. */
async function runtimeImplementation() {
	const require = createRequire(import.meta.url);
	const { build } = require("esbuild");
	const built = await build({
		entryPoints: [join(toolsRoot, "deploy/ack/custom-capacity-runtime.mts")],
		bundle: true,
		write: false,
		platform: "node",
		target: "node24",
		format: "cjs",
		logLevel: "silent",
		alias: {
			"@agent-infra/contracts/runtime": join(
				toolsRoot,
				"packages/contracts/src/runtime/index.ts",
			),
			"@agent-infra/contracts": join(
				toolsRoot,
				"packages/contracts/src/index.ts",
			),
			"@agent-infra/platform-core": join(
				toolsRoot,
				"packages/platform-core/src/index.ts",
			),
		},
	});
	const module = { exports: {} as any };
	new Function("require", "module", "exports", built.outputFiles[0].text)(
		require,
		module,
		module.exports,
	);
	return {
		measure: module.exports.measureCustomRuntime as (
			options: any,
		) => Promise<any>,
		bundleSha256: sha256(built.outputFiles[0].contents),
	};
}

export function buildCustomMeasurementPod(
	job: CustomCapacityJob,
	owner: string,
	secretName: string,
	publicKey: string,
	customKeys: string[],
) {
	const podName = `ack-custom-capacity-${owner.slice(0, 8)}`;
	return {
		apiVersion: "v1",
		kind: "Pod",
		metadata: {
			name: podName,
			namespace: job.namespace,
			labels: labels(job, owner),
		},
		spec: {
			automountServiceAccountToken: false,
			restartPolicy: "Never",
			nodeSelector: job.placement.nodeSelector,
			tolerations: job.placement.tolerations,
			imagePullSecrets: job.imagePullSecret
				? [{ name: job.imagePullSecret }]
				: [],
			securityContext: {
				runAsNonRoot: true,
				runAsUser: 1000,
				runAsGroup: 1000,
				fsGroup: 1000,
				seccompProfile: { type: "RuntimeDefault" },
			},
			containers: [
				{
					name: "runtime",
					image: job.imageReference,
					resources: job.resources,
					securityContext: {
						allowPrivilegeEscalation: false,
						readOnlyRootFilesystem: true,
						capabilities: { drop: ["ALL"] },
					},
					ports: [{ containerPort: 3003 }],
					readinessProbe: {
						httpGet: { path: "/healthz", port: 3003 },
						initialDelaySeconds: 2,
						periodSeconds: 3,
					},
					volumeMounts: [
						{ name: "data", mountPath: "/var/lib/agent-runtime" },
						{ name: "workspace", mountPath: "/workspace" },
						{ name: "tmp", mountPath: "/tmp" },
					],
					env: [
						...[
							["PORT", "3003"],
							["AGENT_INFRA_RUNTIME_DATA_DIR", "/var/lib/agent-runtime"],
							["AGENT_INFRA_RUNTIME_DRIVER", "acp"],
							["AGENT_INFRA_RUNTIME_AGENT_ID", `custom-capacity-${owner}`],
							["AGENT_INFRA_RUNTIME_WORKER_ID", `capacity-worker-${owner}`],
							["AGENT_INFRA_RUNTIME_GRANT_ISSUER", `capacity-${owner}`],
							["AGENT_INFRA_RUNTIME_GRANT_KEY_ID", "capacity-v1"],
							["AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY", publicKey],
						].map(([name, value]) => ({ name, value })),
						...[
							["AGENT_INFRA_RUNTIME_SERVICE_TOKEN", "service-token"],
							...customKeys.map((key) => [key, key]),
						].map(([name, key]) => ({
							name,
							valueFrom: { secretKeyRef: { name: secretName, key } },
						})),
					],
				},
			],
			volumes: ["data", "workspace", "tmp"].map((name) => ({
				name,
				emptyDir: {},
			})),
		},
	};
}
const labels = (job: CustomCapacityJob, owner: string) => ({
	"agent-infra.validation-owner": owner,
	"agent-infra.validation-source": job.sourceCommit,
	"agent-infra.validation-scope": CUSTOM_CAPACITY_SCOPE,
});

async function atomicWrite(file: string, bytes: Uint8Array) {
	const temp = `${file}.${randomUUID()}.tmp`;
	try {
		await writeFile(temp, bytes, { mode: 0o600, flag: "wx" });
		await rename(temp, file);
	} finally {
		await unlink(temp).catch(() => {});
	}
}
function failureCode(error: unknown) {
	const message = error instanceof Error ? error.message : "";
	return /^CUSTOM_CAPACITY_[A-Z0-9_]{1,100}$/u.test(message)
		? message
		: "CUSTOM_CAPACITY_MEASUREMENT_FAILED";
}

/** Return only hashes and the selected non-secret model metadata from the owned image. */
export const runtimeReadbackScript = `
const fs=require('node:fs'),crypto=require('node:crypto'),{isDeepStrictEqual}=require('node:util');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const moduleBytes=fs.readFileSync(process.argv[1]);
const configBytes=fs.readFileSync(process.argv[2]);
const config=JSON.parse(configBytes.toString());
const candidates=fs.readdirSync('/proc').filter(pid=>{
 if(!/^[0-9]+$/.test(pid)||Number(pid)===process.pid)return false;
 try{
  const argv=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0');
  return argv[0]?.split('/').at(-1)==='node'&&argv.includes('--disable-sigusr1')&&(argv.includes('/app/dist/index.mjs')||(argv.includes('dist/index.mjs')&&fs.readlinkSync('/proc/'+pid+'/cwd')==='/app'));
 }catch{return false;}
});
if(candidates.length!==1)process.exit(2);
const pid=candidates[0],proc='/proc/'+pid;
const entry=fs.readFileSync(proc+'/environ','utf8').split('\\0').filter(x=>x.startsWith('AGENT_INFRA_RUNTIME_MODEL_CONFIG='));
if(entry.length!==1)process.exit(2);
const effectiveBytes=entry[0].slice('AGENT_INFRA_RUNTIME_MODEL_CONFIG='.length);
if(!isDeepStrictEqual(config,JSON.parse(effectiveBytes)))process.exit(2);
const processStart=fs.readFileSync(proc+'/stat','utf8').split(') ')[1].split(' ')[19];
const option=config.modelOptions?.find(x=>x.modelOptionId===process.argv[3]);
if(config.schemaVersion!==3||!option)process.exit(2);
process.stdout.write(JSON.stringify({moduleSha256:hash(moduleBytes),configurationSha256:hash(configBytes),effectiveConfigurationSha256:hash(effectiveBytes),processId:Number(pid),processStart,schemaVersion:config.schemaVersion,configVersion:config.configVersion,modelOptionId:option.modelOptionId,modelId:option.model,reasoningLevels:option.reasoningLevels}));
`;

export async function executeCustomCapacityJob(
	jobPath: string,
	externalSignal?: AbortSignal,
) {
	const originalJobBytes = await privateBytes(jobPath);
	const job = validateCustomCapacityJob(readJson(originalJobBytes));
	assert(
		!(await lstat(job.outputDirectory)).isSymbolicLink(),
		"CUSTOM_CAPACITY_OUTPUT_INVALID",
	);
	const output = await realpath(job.outputDirectory);
	const outputStat = await lstat(output);
	assert(
		outputStat.isDirectory() &&
			outputStat.uid === process.getuid?.() &&
			(outputStat.mode & 0o077) === 0,
		"CUSTOM_CAPACITY_OUTPUT_INVALID",
	);
	let insideGit = false;
	try {
		insideGit = git(output, "rev-parse", "--is-inside-work-tree") === "true";
	} catch {}
	assert(!insideGit, "CUSTOM_CAPACITY_OUTPUT_IN_GIT");
	// Existing checkpoints are never silently resubmitted; each attempt has a new private output directory.
	const runDirectory = join(output, "measurement");
	await mkdir(runDirectory, { mode: 0o700 });
	const abort = new AbortController();
	const timeout = setTimeout(
		() => abort.abort(new Error("CUSTOM_CAPACITY_DEADLINE")),
		job.timeoutSeconds * 1000,
	);
	const signal = externalSignal
		? AbortSignal.any([abort.signal, externalSignal])
		: abort.signal;
	const interrupted = () =>
		abort.abort(new Error("CUSTOM_CAPACITY_INTERRUPTED"));
	process.once("SIGINT", interrupted);
	process.once("SIGTERM", interrupted);
	const owner = randomUUID();
	const resourceName = `ack-custom-capacity-${owner.slice(0, 8)}`;
	let kube: ReturnType<typeof createCustomCapacityKubernetes> | undefined;
	let forward: { baseUrl: string; close: () => Promise<void> } | undefined;
	let result: any;
	let code: string | undefined;
	let frozenKubeconfig: string | undefined;
	let stage = "input-verification";
	try {
		const identity = await identities(job);
		const kubeconfigBytes = await privateBytes(job.kubeconfig);
		const privateInputs = await Promise.all(
			[
				job.childManifestFile,
				job.imageConfigFile,
				job.parentManifestFile,
				job.recipeFile,
				job.customEnvironmentFile,
			].map(privateBytes),
		);
		const [child, config, parent, recipe, environment] = privateInputs;
		assert(
			child && config && parent && recipe && environment,
			"CUSTOM_CAPACITY_INPUT_MISSING",
		);
		const image = verifyCustomImageEvidence(job, {
			child,
			config,
			parent,
			recipe,
		});
		const customEnv = validateCustomEnvironment(readJson(environment));
		const { privateKey, publicKey } = generateKeyPairSync("ed25519");
		const serviceToken = randomBytes(32).toString("base64url");
		const implementation = await runtimeImplementation();
		signal.throwIfAborted();
		// Flatten locally before creating anything so later input edits cannot redirect cleanup.
		const kubeconfigSnapshot = execFileSync(
			"kubectl",
			[
				"--kubeconfig",
				job.kubeconfig,
				"config",
				"view",
				"--raw",
				"--flatten",
				"--minify",
				"-o",
				"json",
			],
			{
				timeout: 10_000,
				maxBuffer: 1024 * 1024,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const kubeConfiguration = readJson(kubeconfigSnapshot);
		assert(
			kubeConfiguration.users?.length === 1 &&
				kubeConfiguration.clusters?.length === 1 &&
				kubeConfiguration.contexts?.length === 1,
			"CUSTOM_CAPACITY_KUBECONFIG_INVALID",
		);
		const authentication = kubeConfiguration.users[0]?.user;
		assert(
			authentication &&
				![
					"exec",
					"auth-provider",
					"tokenFile",
					"client-key",
					"client-certificate",
				].some((key) => key in authentication) &&
				!("certificate-authority" in kubeConfiguration.clusters[0].cluster),
			"CUSTOM_CAPACITY_KUBECONFIG_EXTERNAL_INPUT",
		);
		assert(
			(await privateBytes(job.kubeconfig)).equals(kubeconfigBytes),
			"CUSTOM_CAPACITY_KUBECONFIG_DRIFT",
		);
		frozenKubeconfig = join(runDirectory, "kubeconfig.private.json");
		await writeFile(frozenKubeconfig, kubeconfigSnapshot, {
			mode: 0o600,
			flag: "wx",
		});
		signal.throwIfAborted();
		kube = createCustomCapacityKubernetes({
			kubeconfig: frozenKubeconfig,
			namespace: job.namespace,
			owner,
			sourceCommit: job.sourceCommit,
			imageReference: job.imageReference,
			imageDigest: job.imageDigest,
			platform: job.platform,
			resources: job.resources,
			signal,
		});
		stage = "resource-create";
		await kube.createSecret({
			apiVersion: "v1",
			kind: "Secret",
			type: "Opaque",
			metadata: {
				name: `${resourceName}-auth`,
				namespace: job.namespace,
				labels: labels(job, owner),
			},
			data: Object.fromEntries(
				Object.entries({
					"service-token": serviceToken,
					...customEnv,
				}).map(([key, value]) => [key, Buffer.from(value).toString("base64")]),
			),
		});
		const podRef = await kube.createPod(
			buildCustomMeasurementPod(
				job,
				owner,
				`${resourceName}-auth`,
				publicKey.export({ type: "spki", format: "pem" }).toString(),
				Object.keys(customEnv),
			),
		);
		stage = "pod-ready";
		await kube.waitReady(podRef);
		stage = "runtime-readback";
		const readback = readJson(
			Buffer.from(
				await kube.execInPod(podRef, [
					"node",
					"-e",
					runtimeReadbackScript,
					runtimeModulePath,
					job.modelConfigurationPath,
					job.modelOptionId,
				]),
			),
		);
		assert(
			readback.moduleSha256 === job.runtimeModuleSha256 &&
				readback.configurationSha256 === job.modelConfigurationSha256 &&
				readback.schemaVersion === 3 &&
				readback.configVersion === job.runtimeConfigVersion &&
				readback.modelOptionId === job.modelOptionId &&
				readback.reasoningLevels?.includes(job.reasoningLevel),
			"CUSTOM_CAPACITY_RUNTIME_DRIFT",
		);
		forward = await kube.forward(podRef);
		stage = "runtime-measurement";
		const measured = await implementation.measure({
			baseUrl: forward.baseUrl,
			serviceToken,
			privateKey,
			grantIssuer: `capacity-${owner}`,
			grantKeyId: "capacity-v1",
			workerId: `capacity-worker-${owner}`,
			agentId: `custom-capacity-${owner}`,
			principal: { kind: "application", id: `capacity-principal-${owner}` },
			modelOptionId: job.modelOptionId,
			reasoningLevel: job.reasoningLevel,
			runtimeConfigVersion: job.runtimeConfigVersion,
			expectedModelId: job.expectedModelId,
			expectedReply: "READY",
			signal,
			checkpoint: async (checkpoint: unknown) => {
				signal.throwIfAborted();
				await atomicWrite(
					join(runDirectory, "checkpoint.json"),
					evidenceBytes(checkpoint),
				);
				signal.throwIfAborted();
			},
		});
		stage = "final-readback";
		const observed = await kube.observe(podRef);
		const finalReadback = readJson(
			Buffer.from(
				await kube.execInPod(podRef, [
					"node",
					"-e",
					runtimeReadbackScript,
					runtimeModulePath,
					job.modelConfigurationPath,
					job.modelOptionId,
				]),
			),
		);
		assert.deepEqual(finalReadback, readback, "CUSTOM_CAPACITY_RUNTIME_DRIFT");
		assert.deepEqual(
			await identities(job),
			identity,
			"CUSTOM_CAPACITY_TOOLING_DRIFT",
		);
		assert(
			(await runtimeImplementation()).bundleSha256 ===
				implementation.bundleSha256,
			"CUSTOM_CAPACITY_TOOLING_DRIFT",
		);
		assert(
			(await privateBytes(jobPath)).equals(originalJobBytes),
			"CUSTOM_CAPACITY_JOB_DRIFT",
		);
		for (const [index, path] of [
			job.childManifestFile,
			job.imageConfigFile,
			job.parentManifestFile,
			job.recipeFile,
			job.customEnvironmentFile,
		].entries())
			assert(
				privateInputs[index] &&
					(await privateBytes(path)).equals(privateInputs[index]),
				"CUSTOM_CAPACITY_INPUT_DRIFT",
			);
		signal.throwIfAborted();
		const modelFacts = measured.modelFacts.map((fact: any) => ({
			...fact.payload,
			executionId: fact.executionId,
			cursor: fact.cursor,
			occurredAt: fact.occurredAt,
		}));
		assert(
			modelFacts.filter((fact: any) => fact.phase === "started").length === 1 &&
				modelFacts.filter((fact: any) => fact.phase === "completed").length ===
					1,
			"CUSTOM_CAPACITY_MODEL_FACT_MISSING",
		);
		const submittedAt = Date.parse(measured.submittedAt),
			completedAt = Date.parse(measured.completedAt);
		assert(
			Number.isSafeInteger(submittedAt) &&
				Number.isSafeInteger(completedAt) &&
				completedAt >= submittedAt,
			"CUSTOM_CAPACITY_TIME_INVALID",
		);
		result = {
			schemaVersion: 1,
			scope: CUSTOM_CAPACITY_SCOPE,
			sourceCommit: image.sourceCommit,
			imageDigest: observed.imageDigest,
			imageConfigDigest: image.imageConfigDigest,
			parentDigest: image.parentDigest,
			recipeSha256: image.recipeSha256,
			observedResources: observed.resources,
			maximumConcurrentExecutions: 1,
			terminalStatus: "completed",
			replyMatched: measured.replyMatched,
			replySha256: measured.replySha256,
			modelFacts,
			submittedAt,
			completedAt,
			podUidSha256: sha256(observed.uid),
			nativeModelId: job.expectedModelId,
			configuredModelId: readback.modelId,
			runtimeModuleSha256: readback.moduleSha256,
			modelConfigurationSha256: readback.configurationSha256,
			effectiveConfigurationSha256: readback.effectiveConfigurationSha256,
			negativeChecks: measured.negativeChecks,
			source: {
				...identity,
				bundleSha256: implementation.bundleSha256,
				jobSha256: sha256(originalJobBytes),
				jobDefinitionSha256: customCapacityJobDefinitionHash(job),
			},
			customEnvironmentSha256: sha256(environment),
			kubeconfigSha256: sha256(kubeconfigBytes),
			platformLdapVerified: false,
			platformBusinessAuthorizationVerified: false,
			businessVerified: false,
		};
	} catch (error) {
		code = failureCode(error);
	} finally {
		clearTimeout(timeout);
		try {
			await forward?.close();
		} catch {
			code ??= "CUSTOM_CAPACITY_PORT_FORWARD_CLEANUP_FAILED";
		}
		try {
			const cleanup = kube
				? await kube.cleanup().catch(() => ({
						status: "failed",
						resources: [],
						code: "CUSTOM_CAPACITY_CLEANUP_FAILED",
					}))
				: { status: "cleaned", resources: [] };
			if (cleanup.status !== "cleaned")
				code ??= "CUSTOM_CAPACITY_CLEANUP_FAILED";
			if (frozenKubeconfig)
				await unlink(frozenKubeconfig).catch(() => {
					code ??= "CUSTOM_CAPACITY_PRIVATE_INPUT_CLEANUP_FAILED";
				});
			if (signal.aborted) code ??= failureCode(signal.reason);
			if (result) result.cleanup = cleanup;
			if (code)
				await atomicWrite(
					join(runDirectory, "failure.json"),
					evidenceBytes({
						schemaVersion: 1,
						scope: CUSTOM_CAPACITY_SCOPE,
						status: "failed",
						stage,
						code,
						sourceCommit: job.sourceCommit,
						imageDigest: job.imageDigest,
						cleanup,
						businessVerified: false,
					}),
				);
		} finally {
			process.removeListener("SIGINT", interrupted);
			process.removeListener("SIGTERM", interrupted);
		}
	}
	if (code || !result)
		throw new Error(code ?? "CUSTOM_CAPACITY_MEASUREMENT_FAILED");
	const bytes = evidenceBytes(result);
	await atomicWrite(join(runDirectory, "runtime-capacity.receipt.json"), bytes);
	const profile = capacityProfile(job, bytes);
	await atomicWrite(
		join(runDirectory, "capacity-profile.json"),
		evidenceBytes({ schemaVersion: 1, profiles: [profile] }),
	);
	return {
		status: "passed",
		sourceCommit: job.sourceCommit,
		evidenceSha256: profile.conformanceEvidenceHash,
		businessVerified: false,
	};
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		const jobFile = process.argv[2];
		assert(
			process.argv.length === 3 && jobFile,
			"CUSTOM_CAPACITY_JOB_REQUIRED",
		);
		process.stdout.write(
			`${JSON.stringify(await executeCustomCapacityJob(jobFile))}\n`,
		);
	} catch (error) {
		process.stderr.write(`${failureCode(error)}\n`);
		process.exitCode = 1;
	}
}
