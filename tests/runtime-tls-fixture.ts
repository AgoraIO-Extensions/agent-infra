import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Ephemeral test-only CA and server leaf; no key material enters logs or Git. */
export async function runtimeTlsFixture(
	options: {
		dnsNames?: readonly string[];
		days?: number;
		caDays?: number;
		extendedKeyUsage?: string;
		commonName?: string;
		expiresAt?: Date;
	} = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "runtime-tls-test-"));
	const run = (...args: string[]) =>
		execFileSync("openssl", args, { cwd: directory, stdio: "ignore" });
	const cleanup = () => rm(directory, { recursive: true, force: true });
	try {
		run(
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-days",
			String(options.caDays ?? 2),
			"-subj",
			"/CN=Runtime test CA",
			"-addext",
			"basicConstraints=critical,CA:TRUE",
			"-keyout",
			"ca.key",
			"-out",
			"ca.crt",
		);
		run(
			"req",
			"-new",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-subj",
			`/CN=${options.commonName ?? "unused"}`,
			"-keyout",
			"tls.key",
			"-out",
			"leaf.csr",
		);
		await writeFile(
			join(directory, "extensions.cnf"),
			[
				"basicConstraints=critical,CA:FALSE",
				"keyUsage=critical,digitalSignature,keyEncipherment",
				`extendedKeyUsage=${options.extendedKeyUsage ?? "serverAuth"}`,
				...(options.dnsNames?.length === 0
					? []
					: [
							`subjectAltName=${(options.dnsNames ?? ["localhost"]).map((name) => `DNS:${name}`).join(",")}`,
						]),
			].join("\n"),
		);
		if ((options.days ?? 1) < 0 || options.expiresAt) {
			await writeFile(join(directory, "index.txt"), "");
			await writeFile(join(directory, "serial"), "01\n");
			await writeFile(
				join(directory, "ca.cnf"),
				"[ca]\ndefault_ca=issuer\n[issuer]\ndatabase=index.txt\nserial=serial\nnew_certs_dir=.\ncertificate=ca.crt\nprivate_key=ca.key\ndefault_md=sha256\npolicy=policy\n[policy]\ncommonName=supplied\n",
			);
			run(
				"ca",
				"-batch",
				"-notext",
				"-config",
				"ca.cnf",
				"-in",
				"leaf.csr",
				"-out",
				"tls.crt",
				"-extfile",
				"extensions.cnf",
				"-startdate",
				"20000101000000Z",
				"-enddate",
				options.expiresAt
					? `${options.expiresAt.toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "")}Z`
					: "20010101000000Z",
			);
		} else {
			run(
				"x509",
				"-req",
				"-in",
				"leaf.csr",
				"-CA",
				"ca.crt",
				"-CAkey",
				"ca.key",
				"-CAcreateserial",
				"-days",
				String(options.days ?? 1),
				"-extfile",
				"extensions.cnf",
				"-out",
				"tls.crt",
			);
		}
		return {
			directory,
			ca: await readFile(join(directory, "ca.crt"), "utf8"),
			cert: await readFile(join(directory, "tls.crt"), "utf8"),
			key: await readFile(join(directory, "tls.key"), "utf8"),
			cleanup,
		};
	} catch (error) {
		await cleanup();
		throw error;
	}
}
