// Generate the immutable part of a dedicated Grafana org's file provisioning.
// Credentials and the PostgreSQL TLS root certificate are supplied at runtime.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [destination, platformOps] = process.argv.slice(2);
if (!destination || !platformOps)
	throw new Error("Usage: provision.mts NEW_DIRECTORY HTTPS_PLATFORM_OPS_URL");
const url = new URL(platformOps);
if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/ops")
	throw new Error("Expected the platform HTTPS /ops URL");

const uid = "platform-execution-impact-db";
const template = await readFile(new URL("./execution-impact.json", import.meta.url), "utf8");
const dashboard = JSON.parse(template.replaceAll("${DS_PLATFORM}", uid).replaceAll("${PLATFORM_OPS}", () => url.href));
delete dashboard.__inputs;
await mkdir(destination);
try {
	for (const dir of ["dashboards", "provisioning/dashboards", "provisioning/datasources"])
		await mkdir(join(destination, dir), {recursive: true});
	await writeFile(join(destination,"dashboards/execution-impact.json"), JSON.stringify(dashboard, null, 2)+"\n");
	await writeFile(join(destination,"provisioning/dashboards/platform.yaml"), `apiVersion: 1
providers:
  - name: platform-execution-impact
    orgId: 1
    type: file
    allowUiUpdates: false
    disableDeletion: true
    options:
      path: /etc/grafana/platform-dashboards
`);
	await writeFile(join(destination,"provisioning/datasources/platform.yaml"), `apiVersion: 1
datasources:
  - name: Platform execution impact
    uid: ${uid}
    orgId: 1
    type: grafana-postgresql-datasource
    access: proxy
    editable: false
    url: $OPS_PG_HOSTPORT
    user: $OPS_PG_USER
    jsonData:
      database: $OPS_PG_DATABASE
      sslmode: verify-full
      tlsConfigurationMethod: file-path
      sslRootCertFile: /etc/grafana/platform-ca/ca.crt
      maxOpenConns: 2
      maxIdleConns: 1
    secureJsonData:
      password: $OPS_PG_PASSWORD
`);
} catch (error) {
	await rm(destination,{recursive:true,force:true});
	throw error;
}
