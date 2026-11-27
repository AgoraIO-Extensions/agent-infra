import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type BrowserCapabilityAvailableV1,
	RuntimeModelConfigurationV3Schema,
} from "@agent-infra/contracts/runtime";
import type {
	RuntimeExternalActionAuthorization,
	RuntimeExternalActionAuthorizationResult,
} from "./driver.js";
import type { DynamicConnectionClientV1 } from "./dynamic-connection.js";
import { openRuntimeMessagesTransport } from "./messages-model-transport.js";
import { launchPaseoDaemon } from "./paseo-daemon.js";
import { paseoModelRequest } from "./paseo-model-request.js";
import { openPaseoNativeSession } from "./paseo-native-session.js";
import { openPiPodDaemon, piPodPaths } from "./paseo-pod.js";
import { PaseoTransport } from "./paseo-transport.js";
import {
	openPiDeploymentSkills,
	piSessionSkillReader,
} from "./pi-deployment-skills.js";
import { verifyPiInstallation } from "./pi-installation.js";
import { writePiConfiguration } from "./pi-launch-configuration.js";
import {
	PiRuntimeDriver,
	type PiRuntimeDriverOptions,
} from "./pi-runtime-driver.js";
import { piNativeShellAvailable, piNativeShellToolName } from "./pi-shell.js";
import { piWorkspaceToolNames } from "./pi-tools.js";
import { assertProviderRegistration } from "./provider-registry.js";
import type { NativeSessionOptions } from "./session-runtime-driver.js";
import type { RuntimeFilesystemSkillDirectoryV1 } from "./skill-hub-directory.js";
import type { StandardMcpClientOptions } from "./standard-mcp-client.js";

export interface PiRuntimeOptions {
	/** Worker-attested Agent and Conversation for this Pod's immutable Deployment View. */
	readonly deploymentSkillScope?: string;
	readonly paseoSdk?: true;
	readonly paseoCompanion?: true;
	readonly authorizeModelAction?: PiRuntimeDriverOptions["authorizeModelAction"];
	readonly browserCapability?:
		| BrowserCapabilityAvailableV1
		| (() => BrowserCapabilityAvailableV1 | undefined);
	path: string;
	configVersion: string;
	defaultModelOptionId: string;
	defaultReasoningLevel: string;
	modelOptions: readonly {
		modelOptionId: string;
		model: string;
		reasoningLevels: readonly string[];
		endpoint: string;
		credential?: string;
		authentication: "api-key" | "bearer";
	}[];
	skillDirectory?: RuntimeFilesystemSkillDirectoryV1;
	readonly standardConnectionClient?: StandardMcpClientOptions;
	/** §13.5.6 dynamic manual installation; never together with `standardConnectionClient`. */
	readonly dynamicConnectionClient?: DynamicConnectionClientV1;
	readonly authorizeToolAction?: (
		action: RuntimeExternalActionAuthorization,
	) => Promise<RuntimeExternalActionAuthorizationResult | undefined>;
}

/** Build explicit native Skill arguments from the trusted mounted projection. */
export function piNativeSkillArguments(
	skillDirectory: RuntimeFilesystemSkillDirectoryV1 | undefined,
): readonly string[] {
	const paths = skillDirectory?.nativeSkillPaths?.() ?? [];
	if (
		paths.some(
			(path) =>
				typeof path !== "string" ||
				!isAbsolute(path) ||
				path !== resolve(path) ||
				path.includes("\0") ||
				path.includes("\\") ||
				!/(^|\/)\.agents\/skills\/[a-z0-9][a-z0-9._-]{0,62}\/SKILL\.md$/.test(
					path,
				),
		)
	)
		throw new Error("RUNTIME_SKILL_DIRECTORY_UNAVAILABLE");
	if (new Set(paths).size !== paths.length)
		throw new Error("RUNTIME_SKILL_DIRECTORY_UNAVAILABLE");
	if (paths.length === 0) return ["--no-skills"] as const;
	return [
		"--no-skills",
		...paths.flatMap((path) => ["--skill", path] as const),
	];
}

export async function openPiRuntime(options: PiRuntimeOptions) {
	assertProviderRegistration("pi", "paseo-derived", "pi-jsonl-rpc");
	try {
		RuntimeModelConfigurationV3Schema.parse({
			configVersion: options.configVersion,
			defaultModelOptionId: options.defaultModelOptionId,
			defaultReasoningLevel: options.defaultReasoningLevel,
			schemaVersion: 3,
			modelOptions: options.modelOptions.map(
				({ credential: _credential, ...option }) => ({
					...option,
					protocol: "anthropic-messages-v1",
					credentialEnvironmentVariable:
						"AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_VALIDATED",
				}),
			),
		});
		if (
			options.modelOptions.some((option) =>
				option.reasoningLevels.some(
					(level) => !["low", "medium", "high", "xhigh", "max"].includes(level),
				),
			)
		)
			throw new Error();
	} catch {
		throw new Error("RUNTIME_CONFIGURATION_INVALID");
	}
	const installed = await verifyPiInstallation();
	const launch: (
		...args: [
			...Parameters<PiRuntimeDriverOptions["launch"]>,
			{
				session: NativeSessionOptions;
				endTurn: () => void;
				onUnknown: () => Promise<void>;
				deploymentSkills?: Awaited<ReturnType<typeof openPiDeploymentSkills>>;
			}?,
		]
	) => Promise<
		Awaited<ReturnType<PiRuntimeDriverOptions["launch"]>> & {
			modelAccess: { endpoint: string; credential: string };
		}
	> = async (
		directory,
		selection,
		admit,
		resolveModelCredential,
		openDiagnosticReceipt,
		sdkSession,
	) => {
		const option = options.modelOptions.find(
			(option) => option.modelOptionId === selection.modelOptionId,
		);
		if (!option) throw new Error("RUNTIME_CONFIGURATION_INVALID");
		const nativeSkillArguments = sdkSession
			? ["--no-skills"]
			: piNativeSkillArguments(options.skillDirectory);
		const nativeSkillEnabled = nativeSkillArguments.includes("--skill");
		const transport = await openRuntimeMessagesTransport({
			...option,
			effort: selection.reasoningLevel,
			admit,
			openDiagnosticReceipt,
			...(resolveModelCredential
				? { resolveCredential: resolveModelCredential }
				: {}),
			client: "pi",
			...(sdkSession && options.authorizeModelAction
				? {
						...(sdkSession.deploymentSkills?.folders.length &&
						options.authorizeToolAction
							? {
									readPiSkill: piSessionSkillReader(
										sdkSession.deploymentSkills,
										sdkSession.session,
										options.authorizeToolAction,
									),
								}
							: { textOnly: true as const }),
						openRequest: paseoModelRequest(
							sdkSession.session,
							options.authorizeModelAction,
							sdkSession.endTurn,
							sdkSession.onUnknown,
						),
					}
				: {}),
		});
		try {
			for (const name of [
				"home",
				"config",
				"workspace",
				"workspace/.memory",
				"tmp",
			]) {
				const path = join(directory, name);
				await mkdir(path, { recursive: true, mode: 0o700 });
				if ((await realpath(path)) !== path) throw new Error();
			}
			const config = join(directory, "config");
			const shellAvailable =
				!sdkSession &&
				(await piNativeShellAvailable(join(directory, "workspace")));
			const nativeToolNames = piWorkspaceToolNames.filter(
				(name) =>
					(name !== piNativeShellToolName || shellAvailable) &&
					(name !== "powershell" || process.platform === "win32"),
			);
			await writePiConfiguration(
				config,
				option.model,
				option.reasoningLevels,
				selection.reasoningLevel,
				transport.modelAccess.endpoint,
				nativeSkillEnabled,
			);
			return {
				modelAccess: transport.modelAccess,
				command: installed.executable,
				args: sdkSession
					? [
							installed.cli,
							"--no-tools",
							"--no-extensions",
							"--no-skills",
							"--no-prompt-templates",
							"--no-themes",
							"--no-context-files",
						]
					: [
							installed.cli,
							"--no-approve",
							"--no-extensions",
							...nativeSkillArguments,
							"--no-prompt-templates",
							"--no-themes",
							"--no-context-files",
							"--tools",
							nativeToolNames.join(","),
							"--extension",
							fileURLToPath(new URL("../dist/pi-policy.mjs", import.meta.url)),
						],
				env: {
					PATH: "/usr/local/bin:/usr/bin:/bin",
					HOME: join(directory, "home"),
					TMPDIR: join(directory, "tmp"),
					PI_CODING_AGENT_DIR: config,
					AGENT_INFRA_PI_WORKSPACE: join(directory, "workspace"),
					AGENT_INFRA_PI_MODEL_TOKEN: transport.modelAccess.credential,
				},
				close: () => transport.close(),
				reusable: () => !transport.failure(),
			};
		} catch {
			await transport.close();
			throw new Error("RUNTIME_CONFIGURATION_INVALID");
		}
	};
	return PiRuntimeDriver.open({
		...options,
		...(options.paseoCompanion ? { workspaceRoot: piPodPaths.workspaces } : {}),
		modelOptions: options.modelOptions.map((option) => ({
			modelOptionId: option.modelOptionId,
			nativeModelId: `configured/${option.model}`,
			reasoningLevels: option.reasoningLevels,
		})),
		launch,
		...(options.paseoSdk
			? {
					openPaseoSession: async (session: NativeSessionOptions) => {
						if (
							!options.authorizeModelAction ||
							options.modelOptions.some(
								(option) => option.credential !== undefined,
							) ||
							session.browser
						)
							throw new Error("RUNTIME_AUTHORIZATION_DENIED");
						const option = options.modelOptions.find(
							(opt) => opt.modelOptionId === session.selection.modelOptionId,
						);
						if (!option) throw new Error("RUNTIME_MODEL_SELECTION_UNSUPPORTED");
						let confirmed = false;
						let native:
							| Awaited<ReturnType<typeof openPaseoNativeSession>>
							| undefined;
						const modelUnknown = Promise.withResolvers<void>();
						let markingUnknown: Promise<void> | undefined;
						const markUnknown = () =>
							(markingUnknown ??= session.markUnknown?.() ?? Promise.resolve());
						const deploymentSkills =
							options.paseoCompanion &&
							options.deploymentSkillScope &&
							session.connectionReference
								? await openPiDeploymentSkills({
										scope: options.deploymentSkillScope,
										execution: session.connectionReference,
										hub: options.skillDirectory,
									})
								: undefined;
						if (
							deploymentSkills?.folders.length &&
							!options.authorizeToolAction
						)
							throw new Error("RUNTIME_AUTHORIZATION_DENIED");
						const scopedLaunch = await launch(
							session.directory,
							session.selection,
							session.admit,
							undefined,
							session.openDiagnosticReceipt,
							{
								session,
								deploymentSkills,
								onUnknown: async () => {
									if (await native?.handleCancellationStreamLoss()) return;
									modelUnknown.resolve();
									await markUnknown();
								},
								endTurn: () => {
									confirmed = true;
								},
							},
						);
						let daemon:
							| Awaited<ReturnType<typeof launchPaseoDaemon>>
							| undefined;
						let transport: PaseoTransport | undefined;
						const close = async () => {
							try {
								await scopedLaunch.close?.();
							} finally {
								try {
									await transport?.close();
								} finally {
									await daemon?.close();
								}
							}
						};
						try {
							daemon = options.paseoCompanion
								? await openPiPodDaemon({
										sessionRef: session.runtimeSessionRef,
										model: option.model,
										effort: session.selection.reasoningLevel,
										levels: option.reasoningLevels,
										endpoint: scopedLaunch.modelAccess.endpoint,
										proxyToken: scopedLaunch.modelAccess.credential,
										piSkillFolders: deploymentSkills?.folders,
									})
								: await launchPaseoDaemon({
										directory: session.directory,
										cwd: session.cwd,
										launch: scopedLaunch,
										provider: "pi",
									});
							const model = `configured/${option.model}`;
							transport = new PaseoTransport({
								socketPath: daemon.socketPath,
								password: daemon.password,
								template: "pi",
								model,
								cwd: session.cwd,
								thinkingOptionId: session.selection.reasoningLevel,
							});
							native = await openPaseoNativeSession({
								session: { ...session, markUnknown },
								model,
								transport,
								close,
								exited: Promise.race([daemon.exited, modelUnknown.promise]),
								hasConfirmedModelTurn: () => confirmed,
							});
							return {
								...native,
								assertUnambiguousSkill: deploymentSkills?.assertUnambiguous,
							};
						} catch (error) {
							await close();
							throw error;
						}
					},
				}
			: {}),
	});
}
