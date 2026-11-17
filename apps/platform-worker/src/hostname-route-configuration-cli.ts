import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	hostnameRouteConfigurationPlanV1,
	parseHostnameRouteConfigurationV1,
	serializeHostnameRouteConfigurationV1,
} from "./hostname-route-configuration.js";

/** Local nonsecret config generation only; no deployment module or clients are loaded. */
async function main() {
	const [input, output, ...extra] = process.argv.slice(2);
	if (!input || !output || extra.length)
		throw new Error("HOSTNAME_ROUTE_PRODUCER_USAGE");
	const bytes = await readFile(input);
	if (bytes.length > 131072)
		throw new Error("HOSTNAME_ROUTE_CONFIGURATION_INVALID");
	const configuration = parseHostnameRouteConfigurationV1(
		JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
	);
	const content = serializeHostnameRouteConfigurationV1(configuration);
	const plan = hostnameRouteConfigurationPlanV1(configuration);
	// A fresh output directory prevents overwriting any prior plan or input.
	await mkdir(output, { mode: 0o700 });
	await writeFile(join(output, "hostname-routes.json"), content, {
		mode: 0o600,
		flag: "wx",
	});
	await writeFile(
		join(output, "hostname-routes-plan.json"),
		JSON.stringify(plan, null, 2) + "\n",
		{ mode: 0o600, flag: "wx" },
	);
	process.stdout.write(
		JSON.stringify({
			status: plan.status,
			configurationSha256: plan.configurationSha256,
			fieldMutated: false,
		}) + "\n",
	);
}
try {
	await main();
} catch {
	process.stderr.write("HOSTNAME_ROUTE_PRODUCER_FAILED\n");
	process.exitCode = 1;
}
