// v0.1.7 accepts one static binding per protected publication handler.
// Only preparation and readback run before the new release takes over.
export function createBootstrapPublicationRoutes({ ids, assembly, configuration, createApp, original }) {
	if (typeof assembly.files?.resolveActor !== "function" || typeof assembly.identity?.resolve !== "function") {
		throw new Error("TEMPLATE_PUBLICATION_BOOTSTRAP_IDENTITY_UNAVAILABLE");
	}
	const routes = new Map();
	for (const [templateId, publicationId] of Object.entries(ids)) {
		const loadBinding = async () => {
			const binding = await configuration.loadBinding(publicationId);
			if (binding.publicationId !== publicationId || binding.templateId !== templateId) {
				throw new Error("TEMPLATE_PUBLICATION_BOOTSTRAP_BINDING_MISMATCH");
			}
			return binding;
		};
		routes.set(publicationId, createApp({
			databaseUrl: assembly.databaseUrl,
			identity: assembly.identity,
			automaticPublication: {
				loadBinding,
				// v0.1.7's first-party Files port delegates to browser.resolveCurrentIdentity.
				resolveAdministrator: assembly.files.resolveActor,
				serviceAuthentication: { currentKey: () => configuration.serviceAuthentication.currentKey(publicationId) },
			},
		}));
	}
	return {
		app: {
			fetch(request) {
				const path = new URL(request.url).pathname;
				const [, publicationId, action] = /^\/internal\/ops\/standard-template-releases\/([^/]+)\/([^/]+)$/.exec(path) ?? [];
				const route = routes.get(publicationId);
				if (route) {
					if ((request.method === "POST" && action === "prepare-automatic") ||
						(request.method === "GET" && action === "status-automatic")) return route.app.fetch(request);
					return new Response(null, { status: 403 });
				}
				return original?.app.fetch(request) ?? new Response(null, { status: 404 });
			},
		},
		async close() {
			await Promise.all([...routes.values(), ...(original ? [original] : [])].map(route => route.close()));
		},
	};
}
