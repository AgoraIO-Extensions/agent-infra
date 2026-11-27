import { serve } from "@hono/node-server";
import { createAgentsAnywhereAdapter } from "./app.js";

const config = process.argv[2];
if (!config)
	throw Error("Supply the path to the provider's account configuration");
const port = Number(process.env.PORT ?? 8080);
serve({
	fetch: createAgentsAnywhereAdapter(config).fetch,
	hostname: "127.0.0.1",
	port,
});
