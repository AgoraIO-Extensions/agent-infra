import rawPostgres from "postgres";
import {
	observePostgresClient,
	type StoreQueryObservabilityOptions,
} from "./query-observability.js";

let configured: StoreQueryObservabilityOptions = {};

export function configureStoreQueryObservability(
	options: StoreQueryObservabilityOptions | undefined,
): void {
	configured = options ?? {};
}

const observedPostgres = Object.assign(
	((...args: Parameters<typeof rawPostgres>) =>
		observePostgresClient(
			rawPostgres(...args),
			configured,
		)) as typeof rawPostgres,
	rawPostgres,
);

export default observedPostgres;
