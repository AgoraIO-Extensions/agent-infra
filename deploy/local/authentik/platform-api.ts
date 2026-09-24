import { serve } from "@hono/node-server";
import type { createPlatformApp } from "../../../apps/platform-api/src/app.ts";
import type {
	assemblePlatformApi,
	PlatformApiAssemblyInput,
} from "../../../apps/platform-api/src/index.ts";
import {
	type AuthentikBrowserConfiguration,
	createAuthentikBrowserAdapter,
} from "./browser.ts";
import {
	type AuthentikDirectoryConfiguration,
	createAuthentikDirectory,
} from "./directory.ts";

type Directory = ReturnType<typeof createAuthentikDirectory>;
type Browser = ReturnType<typeof createAuthentikBrowserAdapter>;

/** The deployment supplies the actual API module and its non-identity policies. */
export async function startAuthentikPlatformApi(input: {
	directory: AuthentikDirectoryConfiguration;
	browser: AuthentikBrowserConfiguration;
	port: number;
	runtime: {
		assemblePlatformApi: typeof assemblePlatformApi;
		createPlatformApp: typeof createPlatformApp;
	};
	createAssemblyInput: (identity: {
		identity: Browser["identityAdapter"];
		loadAuthorityContext: Directory["loadAuthorityContext"];
	}) => PlatformApiAssemblyInput | Promise<PlatformApiAssemblyInput>;
}) {
	if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535)
		throw new Error("AUTHENTIK_DEPLOYMENT_CONFIGURATION_INVALID");
	if (input.directory.issuer !== input.browser.issuer)
		throw new Error("AUTHENTIK_DEPLOYMENT_CONFIGURATION_INVALID");
	const directory = createAuthentikDirectory(input.directory);
	let browser: Browser | undefined;
	let assembly:
		| ReturnType<typeof input.runtime.assemblePlatformApi>
		| undefined;
	let app: ReturnType<typeof input.runtime.createPlatformApp> | undefined;
	let server: ReturnType<typeof serve>;
	try {
		browser = createAuthentikBrowserAdapter(input.browser, directory);
		const currentBrowser = browser;
		const assemblyInput = await input.createAssemblyInput({
			identity: currentBrowser.identityAdapter,
			loadAuthorityContext: directory.loadAuthorityContext,
		});
		if (assemblyInput.identity !== currentBrowser.identityAdapter)
			throw new Error("AUTHENTIK_DEPLOYMENT_IDENTITY_NOT_CONNECTED");
		assembly = input.runtime.assemblePlatformApi(assemblyInput);
		app = input.runtime.createPlatformApp(assembly.dependencies);
		const currentApp = app;
		server = serve({
			hostname: "127.0.0.1",
			port: input.port,
			fetch: async (request) =>
				(await currentBrowser.handleRequest(request)) ??
				currentApp.fetch(request),
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.once("listening", () => {
				server.off("error", reject);
				resolve();
			});
		});
	} catch (error) {
		browser?.close();
		await assembly?.close();
		throw error;
	}
	if (!browser || !assembly || !app)
		throw new Error("AUTHENTIK_DEPLOYMENT_STARTUP_FAILED");
	const activeBrowser = browser;
	const activeAssembly = assembly;
	let closing: Promise<void> | undefined;
	return {
		server,
		close() {
			closing ??= new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				if ("closeAllConnections" in server) server.closeAllConnections();
			})
				.finally(() => activeBrowser.close())
				.finally(() => activeAssembly.close());
			return closing;
		},
	};
}
