import { Hono } from "hono";
import { HttpProtocolError, requestMetadata } from "./http/common.js";
import {
	type ConfigurationRoutesDependencies,
	registerConfigurationRoutes,
} from "./http/configuration-routes.js";
import {
	type ConversationRoutesDependencies,
	registerConversationRoutes,
} from "./http/conversation-routes.js";
import {
	type FileRoutesDependenciesV1,
	registerFileRoutesV1,
} from "./http/file-routes.js";
import {
	type ManagementRouteDependencies,
	registerManagementRoutes,
} from "./http/management-routes.js";
import { registerRetiredManagementRoutes } from "./http/retired-management-routes.js";
import {
	registerSessionAuditRoutes,
	type SessionAuditRoutesDependencies,
} from "./http/session-audit-routes.js";
import {
	registerWecomReceiptRoutesV1,
	registerWecomRoutesV1,
	type WecomReceiptRoutesDependenciesV1,
	type WecomRoutesDependenciesV1,
} from "./http/wecom-routes.js";
import { registerWecomSetupRoutesV1 } from "./http/wecom-setup-routes.js";

export const platformApiService = "platform-api";

export interface PlatformAppDependencies {
	readonly requestScope?: (
		request: Request,
		work: () => Promise<void>,
	) => Promise<void>;
	readonly wecom?: WecomRoutesDependenciesV1;
	readonly wecomReceipts?: WecomReceiptRoutesDependenciesV1;
	readonly wecomSetup?: Parameters<typeof registerWecomSetupRoutesV1>[1];
	readonly files?: FileRoutesDependenciesV1;
	readonly configuration: ConfigurationRoutesDependencies;
	readonly conversation: ConversationRoutesDependencies;
	readonly management: ManagementRouteDependencies;
	readonly sessionAudit: SessionAuditRoutesDependencies;
}

export function createPlatformHealthApp() {
	const app = new Hono();
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
		}),
	);
	return app;
}

export function createPlatformApp(dependencies: PlatformAppDependencies) {
	const app = createPlatformHealthApp();
	if (dependencies.requestScope) {
		const requestScope = dependencies.requestScope;
		app.use("*", (context, next) => requestScope(context.req.raw, next));
	}
	registerRetiredManagementRoutes(app);
	if (dependencies.wecomSetup)
		registerWecomSetupRoutesV1(app, dependencies.wecomSetup);
	if (dependencies.wecom) registerWecomRoutesV1(app, dependencies.wecom);
	else if (dependencies.wecomReceipts)
		registerWecomReceiptRoutesV1(app, dependencies.wecomReceipts);
	registerManagementRoutes(app, dependencies.management);
	registerConfigurationRoutes(app, dependencies.configuration);
	registerConversationRoutes(app, {
		...dependencies.conversation,
		files: dependencies.files,
	});
	registerSessionAuditRoutes(app, dependencies.sessionAudit);
	if (dependencies.files) registerFileRoutesV1(app, dependencies.files);
	return app;
}
