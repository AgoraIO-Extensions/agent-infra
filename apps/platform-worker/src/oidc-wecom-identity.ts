import {
	createWecomEmployeeIdentity,
	type WecomEmployeeConfiguration,
} from "@agent-infra/identity";
import {
	PostgresOidcIdentityStore,
	PostgresPlatformUserDisablesV1,
} from "@agent-infra/platform-store";

export type { WecomEmployeeConfiguration } from "@agent-infra/identity";
export function openWecomEmployeeIdentity(
	config: WecomEmployeeConfiguration,
	databaseUrl: string,
) {
	const store = new PostgresOidcIdentityStore(databaseUrl);
	const disables = new PostgresPlatformUserDisablesV1(
		databaseUrl,
		async () => null,
	);
	const authority = createWecomEmployeeIdentity(config, store, (id) =>
		disables.isPlatformDisabled(id),
	);
	return {
		...authority,
		close: async () => {
			await Promise.all([store.close(), disables.close()]);
		},
	};
}
