import type { startObservability } from "@agent-infra/observability";
import { createHttpObservability } from "@agent-infra/observability/http";
import { Hono } from "hono";
import { HttpProtocolError, requestMetadata } from "./http/common.js";
import type { ConfigurationRoutesDependencies } from "./http/configuration-routes.js";
import {
	type ConversationRoutesDependencies,
	registerConversationRoutes,
} from "./http/conversation-routes.js";
import {
	type DeploymentConfigurationRoutesDependencies,
	registerDeploymentConfigurationRoutes,
} from "./http/deployment-configuration-routes.js";
import {
	type FileRoutesDependenciesV1,
	registerFileRoutesV1,
} from "./http/file-routes.js";
import {
	type ManagementRouteDependencies,
	registerApiIdentityRoutes,
} from "./http/management-routes.js";
import { registerRetiredManagementRoutes } from "./http/retired-management-routes.js";
import {
	registerScopedAuditRoutes,
	type ScopedAuditRoutesDependencies,
} from "./http/scoped-audit-routes.js";
import {
	registerSessionAuditRoutes,
	type SessionAuditRoutesDependencies,
} from "./http/session-audit-routes.js";
import {
	registerTaskRoutes,
	type TaskRoutesDependencies,
} from "./http/task-routes.js";
import { registerV2CompatibilityRoutes } from "./http/v2-compat.js";
import { registerV2ConfigurationRoutes } from "./http/v2-configuration-routes.js";
import { registerV2ManagementRoutes } from "./http/v2-management-routes.js";
import {
	registerWecomReceiptRoutesV1,
	registerWecomRoutesV1,
	type WecomReceiptRoutesDependenciesV1,
	type WecomRoutesDependenciesV1,
} from "./http/wecom-routes.js";
import { registerWecomSetupRoutesV1 } from "./http/wecom-setup-routes.js";

export const platformApiService = "platform-api";

type ApiObservability = Pick<
	ReturnType<typeof startObservability>,
	"record" | "status"
>;

type ApiSseObservability = Pick<
	ReturnType<typeof startObservability>,
	"record" | "observeResource"
>;

type ConversationSseObserver = NonNullable<
	ConversationRoutesDependencies["observeSse"]
>;

export function bindConversationSseTelemetry(
	conversation: ConversationRoutesDependencies,
	observability: ApiSseObservability | undefined,
): ConversationRoutesDependencies {
	if (!observability) return conversation;
	return {
		...conversation,
		observeSse: {
			record(event: Parameters<ConversationSseObserver["record"]>[0]) {
				try {
					conversation.observeSse?.record(event);
				} catch {
					// A secondary observer cannot change stream behavior.
				}
				try {
					observability.record({
						stage: "sse",
						ssePhase: event.phase,
						outcome: event.outcome,
						durationMs: event.durationMs,
						requestId: event.requestId,
						traceId: event.traceId,
						conversationId: event.conversationId,
					} satisfies Parameters<ApiSseObservability["record"]>[0]);
				} catch {
					// Telemetry failure cannot change stream behavior.
				}
			},
			observeResource(snapshot) {
				try {
					conversation.observeSse?.observeResource(snapshot);
				} catch {
					// A secondary observer cannot change stream behavior.
				}
				try {
					observability.observeResource(snapshot);
				} catch {
					// Telemetry failure cannot change stream behavior.
				}
			},
		},
	};
}

export interface PlatformAppDependencies {
	readonly requestScope?: (
		request: Request,
		work: () => Promise<void>,
	) => Promise<void>;
	readonly files?: FileRoutesDependenciesV1;
	readonly configuration: ConfigurationRoutesDependencies;
	readonly deploymentConfiguration?: DeploymentConfigurationRoutesDependencies;
	readonly conversation: ConversationRoutesDependencies;
	readonly tasks?: TaskRoutesDependencies;
	readonly management: ManagementRouteDependencies;
	readonly sessionAudit: SessionAuditRoutesDependencies;
	readonly wecom?: WecomRoutesDependenciesV1;
	readonly wecomReceipts?: WecomReceiptRoutesDependenciesV1;
	readonly wecomSetup?: Parameters<typeof registerWecomSetupRoutesV1>[1];
	readonly wecomApplicationSetup?: Parameters<
		typeof registerWecomSetupRoutesV1
	>[1];
	readonly scopedAudit?: ScopedAuditRoutesDependencies;
}

export function createPlatformHealthApp(observability?: ApiObservability) {
	const app = new Hono();
	if (observability) app.use("*", createHttpObservability(observability));
	app.onError((error, context) => {
		const protocol =
			error instanceof HttpProtocolError
				? error
				: new HttpProtocolError(
						"INTERNAL_ERROR",
						requestMetadata(context.req.raw).traceId,
					);
		return context.json(protocol.body, protocol.status);
	});

	app.get("/healthz", (context) =>
		context.json({
			service: platformApiService,
			status: "ok",
			...(observability ? { observability: observability.status() } : {}),
		}),
	);
	return app;
}

export function createPlatformApp(
	dependencies: PlatformAppDependencies,
	observability?: ApiObservability & ApiSseObservability,
) {
	const app = createPlatformHealthApp(observability);
	const requestScope = dependencies.requestScope;
	if (requestScope)
		app.use("*", (context, next) => requestScope(context.req.raw, next));
	if (dependencies.wecomSetup)
		registerWecomSetupRoutesV1(app, dependencies.wecomSetup);
	if (dependencies.wecomApplicationSetup)
		registerWecomSetupRoutesV1(app, {
			...dependencies.wecomApplicationSetup,
			application: true,
		});
	if (dependencies.wecom) registerWecomRoutesV1(app, dependencies.wecom);
	else if (dependencies.wecomReceipts)
		registerWecomReceiptRoutesV1(app, dependencies.wecomReceipts);
	registerRetiredManagementRoutes(app);
	registerApiIdentityRoutes(app, dependencies.management);
	registerV2ManagementRoutes(app, dependencies.management);
	registerV2ConfigurationRoutes(app, dependencies.configuration);
	if (dependencies.deploymentConfiguration)
		registerDeploymentConfigurationRoutes(
			app,
			dependencies.deploymentConfiguration,
		);
	registerConversationRoutes(app, {
		...bindConversationSseTelemetry(dependencies.conversation, observability),
		files: dependencies.files,
	});
	registerSessionAuditRoutes(app, dependencies.sessionAudit);
	if (dependencies.tasks) registerTaskRoutes(app, dependencies.tasks);
	if (dependencies.scopedAudit)
		registerScopedAuditRoutes(app, dependencies.scopedAudit);
	if (dependencies.files) registerFileRoutesV1(app, dependencies.files);
	registerV2CompatibilityRoutes(app);
	return app;
}
