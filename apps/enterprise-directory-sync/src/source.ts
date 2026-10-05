import { readFile } from "node:fs/promises";
import {
	createWeComSource,
	type DirectorySource,
} from "@agent-infra/enterprise-directory";

/** Deployment-owned local modules adapt enterprise protocols outside Platform. */
export async function loadDirectorySource(
	env: NodeJS.ProcessEnv,
	rootDepartmentId: number,
	load: (url: string) => Promise<unknown> = (url) => import(url),
): Promise<{ sourceId: string; source: DirectorySource }> {
	const moduleUrl = env.DIRECTORY_SOURCE_MODULE;
	if (moduleUrl) {
		try {
			const url = new URL(moduleUrl);
			if (url.protocol !== "file:" || url.host || url.search || url.hash)
				throw new Error();
			const module = (await load(url.href)) as {
				sourceId?: unknown;
				source?: Partial<DirectorySource>;
			};
			if (
				typeof module.sourceId !== "string" ||
				!/^[a-z][a-z0-9-]{0,63}$/u.test(module.sourceId) ||
				typeof module.source?.fetchComplete !== "function"
			)
				throw new Error();
			return {
				sourceId: module.sourceId,
				source: module.source as DirectorySource,
			};
		} catch {
			throw new Error("DIRECTORY_SOURCE_MODULE_INVALID");
		}
	}
	const secretFile = env.WECOM_CORP_SECRET_FILE;
	const corpId = env.WECOM_CORP_ID;
	if (!secretFile || !corpId)
		throw new Error("Directory source credentials are required");
	const corpSecret = (await readFile(secretFile, "utf8")).trim();
	if (!corpSecret) throw new Error("Directory source credentials are required");
	return {
		sourceId: "wecom",
		source: createWeComSource({ corpId, corpSecret, rootDepartmentId }),
	};
}
