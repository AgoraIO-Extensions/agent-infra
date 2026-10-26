import { isDeepStrictEqual } from "node:util";

import type { AgentConfigurationRecord } from "./agent-configuration.js";
import {
	type AgentManagementActorContextV1,
	type AgentManagementStateV1,
	isAgentAccessAllowedV1,
} from "./agent-management.js";
import {
	AgentManagementError,
	parseAgentManagementPortState,
	requireAgentManagementExactKeys,
	snapshotAgentManagementDataObject,
} from "./agent-management-input.js";
import { isPersonalApiAgentMetadataReadAllowedV1 } from "./personal-api-agent-read.js";
import type {
	WorkloadBrowserCapabilityProjectionV1,
	WorkloadReconciliationStateV1,
	WorkloadSkillCapabilityV1,
} from "./workload-reconciliation.js";

/** Current explicit grants for the exact user/Agent, resolved by Store. */
interface ApiMetadataAccess {
	readonly agentId: string;
	readonly userId: string;
	readonly grantTypes: readonly string[];
}

export interface AgentRuntimePresentationExpectationV1 {
	readonly configurationRevision: number;
	readonly management: AgentManagementStateV1;
}

/** 企微连接行按租约推导后的状态：auth_failed 原样保留，租约已失效的行视为 disconnected。 */
export type AgentChannelConnectionStatusV1 =
	| "verifying"
	| "connected"
	| "disconnected"
	| "auth_failed";

/**
 * 当前修订中一个企微渠道绑定引用的连接事实（#2910），由 Store 在同一只读快照内读取。
 * 只含判定所需的粗粒度事实，不含机器人 ID、凭证、持有者或租约。
 */
export interface AgentChannelConnectionFactV1 {
	readonly kind: "wecom_bot" | "wecom_app";
	readonly bindingReference: string;
	/** session_id 等于该绑定引用的配置会话；部署静态绑定没有会话。 */
	readonly session: null | {
		readonly agentId: string;
		readonly kind: string;
		readonly status: string;
		readonly callbackVerified: boolean;
	};
	/** 同一 Agent、同一绑定引用（托管绑定还须是会话的机器人）的连接行。 */
	readonly connections: readonly AgentChannelConnectionStatusV1[];
}

/** 已配置企微渠道的展示状态；取值属于已发布的 ChannelBindingProjectionV1 枚举。 */
export interface AgentChannelPresentationV1 {
	readonly kind: "wecom_bot" | "wecom_app";
	readonly status: "binding" | "bound" | "failed";
}

export type AgentRuntimePresentationDecisionV1 =
	| {
			readonly outcome: "found";
			readonly sourceReference: string;
			/** 当前修订已配置的企微渠道，顺序与配置相同；未配置的渠道不列出。 */
			readonly channels: readonly AgentChannelPresentationV1[];
			readonly capabilities:
				| (Readonly<Record<string, boolean>> & {
						readonly browser?: WorkloadBrowserCapabilityProjectionV1;
						readonly skills?: readonly WorkloadSkillCapabilityV1[];
				  })
				| null;
			readonly interactionUrl: string | null;
	  }
	| { readonly outcome: "unavailable" | "stale" };

/** Only decoded deployment facts used by the presentation policy. */
export interface AgentRuntimePresentationDeploymentV1 {
	readonly agentId: string;
	readonly configRevision: number;
	readonly workloadRevision: number;
	readonly fence: number;
	readonly desiredState: "running" | "stopped" | "disabled";
	readonly imageDigest: string;
	readonly runtimeManifest: {
		readonly interactionMode: "platform-adapter" | "self-managed";
		readonly capabilities?: {
			readonly browser?: Record<string, unknown>;
		};
	};
	readonly route: {
		readonly exposure: "internal-only" | "platform-auth" | "self-managed";
		/** Store-projected deployment origin; never a Service, Pod or caller URL. */
		readonly interactionOrigin?: string;
	};
}

export interface AgentRuntimePresentationFactsV1 {
	readonly management: AgentManagementStateV1;
	/** 当前配置修订：渠道与 expected 快照比较都以它为准。 */
	readonly configuration: AgentConfigurationRecord;
	/**
	 * 当前 Runtime 修订对应的配置文档（ADR-0028）。只改渠道等非 Runtime 输入时它落后于
	 * `configuration`；verified Workload 与它比较，Runtime 能力投影因此不随渠道变更失效。
	 */
	readonly runtimeConfiguration: AgentConfigurationRecord;
	readonly sourceReference: string;
	/** 当前修订各企微渠道的连接事实；缺少某个渠道的事实时该渠道按未证实处理。 */
	readonly channels: readonly AgentChannelConnectionFactV1[];
	readonly runtime: null | {
		readonly revision: number;
		readonly state: WorkloadReconciliationStateV1;
		readonly verifiedConfiguration: AgentConfigurationRecord;
		readonly verifiedSourceReference: string;
		readonly deployment: AgentRuntimePresentationDeploymentV1;
	};
}

function isCanonicalHttpsOriginV1(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0) return false;
	try {
		const url = new URL(value);
		return (
			value === url.origin &&
			url.protocol === "https:" &&
			url.username === "" &&
			url.password === "" &&
			url.pathname === "/" &&
			url.search === "" &&
			url.hash === "" &&
			url.hostname !== ""
		);
	} catch {
		return false;
	}
}

export function isAgentRuntimePresentationVisibleV1(
	management: AgentManagementStateV1 | null,
	actor: AgentManagementActorContextV1,
	apiMetadata?: ApiMetadataAccess,
): boolean {
	return (
		management !== null &&
		actor.accountStatus === "active" &&
		(apiMetadata === undefined
			? actor.isAdministrator ||
				isAgentAccessAllowedV1(management, actor, "discover")
			: apiMetadata?.agentId === management.agentId &&
				apiMetadata.userId === actor.userId &&
				Array.isArray(apiMetadata.grantTypes) &&
				isPersonalApiAgentMetadataReadAllowedV1(apiMetadata.grantTypes))
	);
}

/** Capture before awaiting Store reads so the upstream snapshot cannot drift in place. */
export function snapshotAgentRuntimePresentationExpectationV1(
	input: AgentRuntimePresentationExpectationV1,
): AgentRuntimePresentationExpectationV1 {
	const value = snapshotAgentManagementDataObject(input);
	requireAgentManagementExactKeys(value, [
		"configurationRevision",
		"management",
	]);
	if (
		!Number.isSafeInteger(value.configurationRevision) ||
		(value.configurationRevision as number) < 1
	)
		throw new AgentManagementError("invalid_input");
	return {
		configurationRevision: value.configurationRevision as number,
		management: parseAgentManagementPortState(
			value.management as AgentManagementStateV1,
		),
	};
}

/**
 * 已配置企微渠道的展示状态只来自该绑定引用的当前事实（#2910），不由 Web 或配置推断：
 * 智能机器人已认证连接为 bound，认证中或尚无连接为 binding，断开或认证失败为 failed；
 * 自建应用走回调没有长连接，激活且回调已验证的托管会话为 bound，部署静态绑定无平台事实时为 binding。
 * 托管会话不再有效、不属于该 Agent 或渠道类型、事实不唯一时一律 failed，不推断为已绑定。
 */
function presentAgentChannelStatusV1(
	agentId: string,
	channel: AgentConfigurationRecord["channels"][number],
	facts: readonly AgentChannelConnectionFactV1[],
): AgentChannelPresentationV1["status"] {
	const matches = facts.filter(
		(fact) =>
			fact.kind === channel.kind &&
			fact.bindingReference === channel.bindingReference,
	);
	if (matches.length === 0) return "binding";
	const [fact] = matches;
	if (matches.length > 1 || !fact || fact.connections.length > 1)
		return "failed";
	const session = fact.session;
	if (
		session &&
		(session.agentId !== agentId ||
			session.kind !== channel.kind ||
			session.status !== "active")
	)
		return "failed";
	const connection = fact.connections[0];
	if (connection === "auth_failed") return "failed";
	if (channel.kind === "wecom_app") {
		if (!session) return "binding";
		return session.callbackVerified ? "bound" : "failed";
	}
	if (connection === "connected") return "bound";
	if (connection === "disconnected") return "failed";
	return "binding";
}

/** A projection must describe one authorized configuration/management snapshot. */
export function decideAgentRuntimePresentationV1(input: {
	readonly agentId: string;
	readonly actor: AgentManagementActorContextV1;
	readonly apiMetadata?: ApiMetadataAccess;
	readonly expected: AgentRuntimePresentationExpectationV1;
	readonly facts: AgentRuntimePresentationFactsV1 | null;
}): AgentRuntimePresentationDecisionV1 {
	const facts = input.facts;
	if (
		!facts ||
		!isAgentRuntimePresentationVisibleV1(
			facts.management,
			input.actor,
			input.apiMetadata,
		)
	)
		return { outcome: "unavailable" };
	const management = parseAgentManagementPortState(facts.management);
	if (management.agentId !== input.agentId) return { outcome: "unavailable" };
	if (
		facts.configuration.agentId !== input.agentId ||
		facts.configuration.revision !== input.expected.configurationRevision ||
		!isDeepStrictEqual(management, input.expected.management)
	)
		return { outcome: "stale" };
	const channels = facts.configuration.channels.map((channel) => ({
		kind: channel.kind,
		status: presentAgentChannelStatusV1(input.agentId, channel, facts.channels),
	}));
	const foundWithoutRuntimeProjection: AgentRuntimePresentationDecisionV1 = {
		outcome: "found",
		sourceReference: facts.sourceReference,
		channels,
		capabilities: null,
		interactionUrl: null,
	};
	const runtime = facts.runtime;
	const browserDeclared =
		runtime?.deployment.runtimeManifest.capabilities?.browser !== undefined;
	if (
		!runtime ||
		management.status !== "available" ||
		management.serviceAvailability !== "ready" ||
		management.desiredState !== "running"
	)
		return browserDeclared
			? { outcome: "unavailable" }
			: foundWithoutRuntimeProjection;
	const { state, deployment, verifiedConfiguration: configuration } = runtime;
	if (
		state.agentId !== input.agentId ||
		state.phase !== "ready" ||
		!state.verified ||
		!state.identity ||
		!state.capabilities ||
		state.fence !== management.fence ||
		state.sourceLifecycleRevision !== management.workloadRevision ||
		state.sourceConfigurationRevision !== facts.runtimeConfiguration.revision ||
		state.revision !== runtime.revision ||
		state.verifiedRevision !== state.revision ||
		!isDeepStrictEqual(state.candidate, state.verified) ||
		!isDeepStrictEqual(configuration, state.verified.configuration) ||
		!isDeepStrictEqual(configuration, facts.runtimeConfiguration) ||
		runtime.verifiedSourceReference !== facts.sourceReference ||
		deployment.agentId !== input.agentId ||
		deployment.configRevision !== configuration.revision ||
		// verified 部署保留产生它的 Workload 修订：漂移恢复与回滚重新提升同一部署时只推进
		// state.revision（Spec §10.4、#1480），因此该值可以落后、不能超前于当前修订。
		// 能力属于当前修订由 phase=ready 与 verifiedRevision === state.revision 证明（#3304）。
		!Number.isSafeInteger(deployment.workloadRevision) ||
		deployment.workloadRevision < 1 ||
		deployment.workloadRevision > state.revision ||
		deployment.fence !== state.fence ||
		deployment.desiredState !== "running" ||
		deployment.imageDigest !== configuration.source.imageDigest
	)
		return browserDeclared
			? { outcome: "unavailable" }
			: foundWithoutRuntimeProjection;
	const mode =
		configuration.source.kind === "standard"
			? "platform-adapter"
			: configuration.source.interactionMode;
	const exposure =
		mode === "platform-adapter"
			? "internal-only"
			: configuration.source.kind === "custom" &&
					configuration.source.identityResponsibility === "platform-managed"
				? "platform-auth"
				: "self-managed";
	if (
		deployment.runtimeManifest.interactionMode !== mode ||
		deployment.route.exposure !== exposure
	)
		return browserDeclared
			? { outcome: "unavailable" }
			: foundWithoutRuntimeProjection;
	if (browserDeclared && !state.capabilities.browser)
		return { outcome: "unavailable" };
	const interactionUrl =
		mode === "self-managed" &&
		configuration.source.kind === "custom" &&
		configuration.source.identityResponsibility === "self-managed" &&
		isCanonicalHttpsOriginV1(deployment.route.interactionOrigin)
			? deployment.route.interactionOrigin
			: null;
	return {
		outcome: "found",
		sourceReference: facts.sourceReference,
		channels,
		capabilities: state.capabilities
			? ({
					...Object.fromEntries(
						Object.entries(state.capabilities).filter(
							([, value]) => typeof value === "boolean",
						),
					),
					...(browserDeclared && state.capabilities.browser
						? { browser: state.capabilities.browser }
						: {}),
					...(state.capabilities.skills
						? { skills: state.capabilities.skills }
						: {}),
				} as Readonly<Record<string, boolean>> & {
					browser?: WorkloadBrowserCapabilityProjectionV1;
					skills?: readonly WorkloadSkillCapabilityV1[];
				})
			: null,
		interactionUrl,
	};
}
