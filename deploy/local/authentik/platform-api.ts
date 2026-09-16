import { serve } from "@hono/node-server";
import type {
	assemblePlatformApi,
	createPlatformApp,
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
	const browser = createAuthentikBrowserAdapter(input.browser, directory);
	const assemblyInput = await input.createAssemblyInput({
		identity: browser.identityAdapter,
		loadAuthorityContext: directory.loadAuthorityContext,
	});
	if (assemblyInput.identity !== browser.identityAdapter)
		throw new Error("AUTHENTIK_DEPLOYMENT_IDENTITY_NOT_CONNECTED");
	const assembly = input.runtime.assemblePlatformApi(assemblyInput);
	const app = input.runtime.createPlatformApp(assembly.dependencies);
	let server: ReturnType<typeof serve>;
	try {
		server = serve({
			port: input.port,
			fetch: async (request) =>
				(await browser.handleRequest(request)) ?? app.fetch(request),
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.once("listening", () => {
				server.off("error", reject);
				resolve();
			});
		});
	} catch (error) {
		await assembly.close();
		throw error;
	}
	let closing: Promise<void> | undefined;
	return {
		server,
		close() {
			closing ??= new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			}).finally(() => assembly.close());
			return closing;
		},
	};
}
