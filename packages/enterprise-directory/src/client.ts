import {
	type DirectorySnapshot,
	DirectoryUnavailableError,
	requireCurrentSnapshot,
} from "./snapshot.js";
import { fromDirectorySnapshot } from "./wire.js";

export interface DirectoryClientConfig {
	endpoint: string;
	token: string;
	fetch?: typeof fetch;
}

export function createDirectoryClient(config: DirectoryClientConfig) {
	const endpoint = new URL(config.endpoint);
	if (
		endpoint.protocol !== "https:" ||
		endpoint.username ||
		endpoint.password ||
		endpoint.search ||
		endpoint.hash ||
		Buffer.byteLength(config.token) < 32
	) {
		throw new DirectoryUnavailableError();
	}
	const fetcher = config.fetch ?? fetch;
	return {
		async loadCurrent(now = Date.now()): Promise<DirectorySnapshot> {
			try {
				const response = await fetcher(endpoint, {
					method: "GET",
					headers: { Authorization: `Bearer ${config.token}` },
					redirect: "error",
					signal: AbortSignal.timeout(5_000),
				});
				if (!response.ok) throw new DirectoryUnavailableError();
				return requireCurrentSnapshot(
					fromDirectorySnapshot(await response.json()),
					now,
				);
			} catch {
				throw new DirectoryUnavailableError();
			}
		},
	};
}
