import type { startObservability } from "@agent-infra/observability";
import { createHttpObservability } from "@agent-infra/observability/http";
import { Hono } from "hono";
import {
	type AgentDefaultRelayKeyRoutesDependencies,
	registerAgentDefaultRelayKeyRoutes,
} from "./http/agent-default-relay-key-routes.js";
import {
	type ApplicationMaterialGrantRouteDependencies,
	registerApplicationMaterialGrantRoutes,
} from "./http/application-material-grant-routes.js";
import {
	type ApplicationRegistrationRouteDependencies,
	registerApplicationRegistrationRoutes,
} from "./http/application-registration-routes.js";
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
	type PersonalApiCredentialRouteDependencies,
	registerPersonalApiCredentialRoutes,
} from "./http/personal-api-credential-routes.js";
import {
	type PersonalRelayKeyRoutesDependencies,
	registerPersonalRelayKeyRoutes,
} from "./http/personal-relay-key-routes.js";
import { registerRetiredManagementRoutes } from "./http/retired-management-routes.js";
import {
	registerScopedAuditRoutes,
	type ScopedAuditRoutesDependencies,
} from "./http/scoped-audit-routes.js";
import {
	registerSessionAuditRoutes,
	type SessionAuditRoutesDependencies,
} from "./http/session-audit-routes.js";
import { registerV2ConfigurationRoutes } from "./http/v2-configuration-routes.js";
import {
	type ManagementRouteDependencies,
	registerV2ManagementRoutes,
} from "./http/v2-management-routes.js";
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

export interface PlatformAppDependencies {
	readonly requestScope?: (
		request: Request,
		work: () => Promise<Response>,
	) => Promise<Response>;
	readonly files?: FileRoutesDependenciesV1;
	readonly applications?: ApplicationRegistrationRouteDependencies;
	readonly applicationMaterialGrants?: ApplicationMaterialGrantRouteDependencies;
	readonly configuration: ConfigurationRoutesDependencies;
	readonly deploymentConfiguration?: DeploymentConfigurationRoutesDependencies;
	readonly conversation: ConversationRoutesDependencies;
	readonly management: ManagementRouteDependencies;
	readonly personalApiCredentials?: PersonalApiCredentialRouteDependencies;
	readonly agentDefaultRelayKeys?: AgentDefaultRelayKeyRoutesDependencies;
	readonly personalRelayKeys?: PersonalRelayKeyRoutesDependencies;
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
	observability?: ApiObservability,
) {
	const app = createPlatformHealthApp(observability);
	const requestScope = dependencies.requestScope;
	if (requestScope)
		app.use("*", async (context, next) => {
			context.res = await requestScope(context.req.raw, async () => {
				await next();
				if (context.error && context.res.status >= 500) throw context.error;
				return context.res;
			});
			return context.res;
		});
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
	if (dependencies.agentDefaultRelayKeys)
		registerAgentDefaultRelayKeyRoutes(app, dependencies.agentDefaultRelayKeys);
	if (dependencies.personalRelayKeys)
		registerPersonalRelayKeyRoutes(app, dependencies.personalRelayKeys);
	registerV2ManagementRoutes(app, dependencies.management);
	if (dependencies.applications)
		registerApplicationRegistrationRoutes(app, dependencies.applications);
	if (dependencies.applicationMaterialGrants)
		registerApplicationMaterialGrantRoutes(
			app,
			dependencies.applicationMaterialGrants,
		);
	if (dependencies.personalApiCredentials)
		registerPersonalApiCredentialRoutes(
			app,
			dependencies.personalApiCredentials,
		);
	registerV2ConfigurationRoutes(app, dependencies.configuration);
	if (dependencies.deploymentConfiguration)
		registerDeploymentConfigurationRoutes(
			app,
			dependencies.deploymentConfiguration,
		);
	registerConversationRoutes(app, {
		...dependencies.conversation,
		files: dependencies.files,
	});
	registerSessionAuditRoutes(app, dependencies.sessionAudit);
	if (dependencies.scopedAudit)
		registerScopedAuditRoutes(app, dependencies.scopedAudit);
	if (dependencies.files) registerFileRoutesV1(app, dependencies.files);
	return app;
}
