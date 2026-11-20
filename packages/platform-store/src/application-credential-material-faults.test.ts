import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ApplicationCredentialMaterialStoreV1,
	createApplicationApiCredentialManagementV1,
	createApplicationCredentialMaterialDeliveryV1,
	createApplicationMaterialGrantUseCaseV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { PostgresApplicationApiCredentialIssuerStoreV1 } from "./application-api-credentials.js";
import { PostgresApplicationCredentialMaterialStoreV1 } from "./application-credential-material.js";
import { PostgresApplicationMaterialGrantStoreV1 } from "./application-material-grant.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";

const randomCount = vi.hoisted(() => ({ calls: 0 }));
vi.mock("node:crypto", async (original) => {
	const actual = await original<typeof import("node:crypto")>();
	return {
		...actual,
		randomBytes: (...args: unknown[]) => {
			if (args[0] === 32) randomCount.calls++;
			return Reflect.apply(actual.randomBytes, actual, args);
		},
	};
});
let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let store: PostgresApplicationCredentialMaterialStoreV1;
let legacy: PostgresApplicationApiCredentialIssuerStoreV1;
let grantStore: PostgresApplicationMaterialGrantStoreV1;
let afterCommit: (phase: string) => Promise<void>;
let inserts = 0;
let sends = 0;
const actor = {
	userId: "admin",
	accountStatus: "active" as const,
	isSystemAdmin: true,
	ldapStableUid: "ldap-admin",
	ldapAdministratorConfigured: true,
	authorizationRevision: "admin-1",
};
const directory = {
	resolveUser: async (userId: string) => ({
		schemaVersion: 1 as const,
		userId,
		accountStatus: "active" as const,
		organizationIds: [],
		authorizationRevision: "identity-1",
	}),
};
const request = {
	applicationId: "app-1",
	userId: "manager",
	requestId: "request",
	traceId: "trace",
	idempotencyKey: "intent",
};
const command = {
	operation: "issue",
	recipient: { principalType: "user", principalId: "recipient" },
	scopes: ["agent:read"],
	expiresAt: null,
};
const grantRequest = {
	actor,
	applicationId: "app-1",
	principalType: "user" as const,
	principalId: "recipient",
	requestId: "grant",
	traceId: "trace",
};
function grants() {
	return createApplicationMaterialGrantUseCaseV1({
		store: grantStore,
		resolveCurrentActor: async () => actor,
		resolveUser: async () => ({ accountStatus: "active" }),
	});
}
function service() {
	const wrapped: ApplicationCredentialMaterialStoreV1 = {
		inspect: (app, id) => store.inspect(app, id),
		async execute(work) {
			let phase = "";
			const result = await store.execute((tx) =>
				work({
					...tx,
					save: async (record) => {
						phase = record.result.metadata.phase;
						await tx.save(record);
					},
					insertCredential: async (...args) => {
						inserts++;
						return tx.insertCredential(...args);
					},
				}),
			);
			await afterCommit(phase);
			return result;
		},
	};
	return createApplicationCredentialMaterialDeliveryV1({
		store: wrapped,
		userDirectory: directory,
		configuration: {
			schemaVersion: 1,
			enabled: true,
			publicOrigin: "https://platform.example.test",
			recipients: [
				{
					applicationId: "app-1",
					principalType: "user",
					principalId: "recipient",
				},
			],
		},
	});
}
const recipient = (attemptId: string) => ({
	applicationId: "app-1",
	attemptId,
	userId: "recipient",
	requestId: "receive",
	traceId: "trace",
});
async function saved(id: string) {
	const record = await store.inspect("app-1", id);
	if (!record) throw new Error("Receipt absent");
	return record;
}
beforeAll(async () => {
	database = await startPostgresTestDatabase("material-faults-4276");
	await migratePlatformDatabase(database);
	sql = postgres(database.databaseUrl, { max: 6 });
	store = new PostgresApplicationCredentialMaterialStoreV1(database);
	legacy = new PostgresApplicationApiCredentialIssuerStoreV1(database);
	grantStore = new PostgresApplicationMaterialGrantStoreV1(database);
}, 120_000);
beforeEach(async () => {
	inserts = 0;
	randomCount.calls = 0;
	sends = 0;
	afterCommit = async () => {};
	await sql`truncate platform.platform_applications,platform.platform_api_credentials,platform.idempotency_records,platform.audit_events,platform.platform_user_disables cascade`;
	await sql`insert into platform.platform_applications(id,name,responsible_user_id,authorization_revision) values('app-1','Application','manager','app-1')`;
	await grants().grant(grantRequest);
});
afterAll(async () => {
	await store?.close();
	await legacy?.close();
	await grantStore?.close();
	await sql?.end();
	await database?.stop();
});
it("persists a bounded deadline reason atomically with expiration audit", async () => {
	const api = service();
	const intent = await api.prepare(request, command);
	await sql`update platform.idempotency_records set result=jsonb_set(result,'{expiresAt}',to_jsonb('2000-01-01T00:00:00Z'::text)) where id=${intent.attemptId}`;
	await api.receive(recipient(intent.attemptId), async () => {
		sends++;
	});
	expect((await saved(intent.attemptId)).failureReason).toBe(
		"deadline_exceeded",
	);
	const rows =
		await sql`select details from platform.audit_events where action='application.credential.material.expired'`;
	expect(rows[0]?.details.failureReason).toBe("deadline_exceeded");
	expect(inserts).toBe(0);
	expect(sends).toBe(0);
});
async function revokeGrant() {
	const grant = await grants().read(grantRequest);
	if (!grant) throw new Error("Grant absent");
	await grants().revoke({
		...grantRequest,
		expectedRevision: grant.authorizationRevision,
	});
}
function onceAfter(phase: string, work: () => Promise<void>) {
	let fired = false;
	afterCommit = async (p) => {
		if (p === phase && !fired) {
			fired = true;
			await work();
		}
	};
}
function gate() {
	let release!: () => void;
	const promise = new Promise<void>((r) => {
		release = r;
	});
	return { promise, release };
}
async function assertNoReplay(
	api: ReturnType<typeof service>,
	id: string,
	reason: string,
	generated: number,
	sent: number,
) {
	const first = await saved(id);
	expect(first.failureReason).toBe(reason);
	const fence = first.result.metadata.fence;
	await api
		.receive(recipient(id), async () => {
			sends++;
		})
		.catch(() => {});
	const last = await saved(id);
	expect(last.result.delivery.attemptId).toBe(id);
	expect(last.result.metadata.fence).toBe(fence);
	expect(last.result.delivery.status).not.toBe("accepted");
	expect(inserts).toBe(generated);
	expect(randomCount.calls).toBe(generated);
	expect(sends).toBe(sent);
	const audits =
		await sql`select details from platform.audit_events where details->>'attemptId'=${id} and details->>'failureReason'=${reason}`;
	expect(audits.length > 0).toBe(true);
}
it.each(["claimed", "generated"])(
	"quarantines %s commit acknowledgement loss without retrying generation",
	async (phase) => {
		const api = service();
		const intent = await api.prepare(request, command);
		onceAfter(phase, async () => {
			throw new Error("controlled commit acknowledgement loss");
		});
		await expect(
			api.receive(recipient(intent.attemptId), async () => {
				sends++;
			}),
		).rejects.toThrow();
		await assertNoReplay(
			api,
			intent.attemptId,
			phase === "claimed"
				? "claim_commit_unconfirmed"
				: "generation_commit_unconfirmed",
			phase === "claimed" ? 0 : 1,
			0,
		);
		const keys = await sql`select id from platform.platform_api_credentials`;
		expect(keys.length).toBe(phase === "claimed" ? 0 : 1);
	},
);
it("a cancelled original request after durable claim cannot resume generation", async () => {
	const api = service();
	const intent = await api.prepare(request, command);
	const controller = new AbortController();
	onceAfter("claimed", async () => {
		controller.abort();
	});
	await expect(
		api.receive(
			{ ...recipient(intent.attemptId), signal: controller.signal },
			async () => {
				sends++;
			},
		),
	).rejects.toThrow();
	await assertNoReplay(api, intent.attemptId, "request_aborted", 0, 0);
});
it.each(["grant", "disable", "credential"])(
	"blocks final sending when %s changes first",
	async (kind) => {
		const api = service();
		const intent = await api.prepare(request, command);
		onceAfter(kind === "credential" ? "generated" : "claimed", async () => {
			if (kind === "grant") await revokeGrant();
			if (kind === "disable")
				await sql`insert into platform.platform_user_disables(user_id) values('recipient')`;
			if (kind === "credential")
				await createApplicationApiCredentialManagementV1({
					store: legacy,
					userDirectory: directory,
				}).revoke(
					{ ...request, idempotencyKey: "revoke" },
					intent.credentialId,
				);
		});
		await expect(
			api.receive(recipient(intent.attemptId), async () => {
				sends++;
			}),
		).rejects.toThrow();
		await assertNoReplay(
			api,
			intent.attemptId,
			kind === "credential" ? "credential_changed" : "authorization_changed",
			kind === "credential" ? 1 : 0,
			0,
		);
	},
);
it.each(["grant", "disable", "credential"])(
	"serializes %s behind an already-held final sending barrier",
	async (kind) => {
		const api = service();
		const intent = await api.prepare(request, command);
		const entered = gate();
		const release = gate();
		const delivery = api.receive(recipient(intent.attemptId), async () => {
			sends++;
			entered.release();
			await release.promise;
		});
		await entered.promise;
		let changed = false;
		const mutation = (async () => {
			if (kind === "grant") await revokeGrant();
			if (kind === "disable")
				await sql`insert into platform.platform_user_disables(user_id) values('recipient')`;
			if (kind === "credential")
				await createApplicationApiCredentialManagementV1({
					store: legacy,
					userDirectory: directory,
				}).revoke(
					{ ...request, idempotencyKey: "revoke" },
					intent.credentialId,
				);
			changed = true;
		})();
		void mutation.catch(() => {});
		try {
			await vi.waitFor(async () => {
				const rows =
					await sql`select pid from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`;
				expect(rows.length > 0).toBe(true);
			});
			expect(changed).toBe(false);
		} finally {
			release.release();
		}
		await delivery;
		await mutation;
		expect(sends).toBe(1);
		expect(inserts).toBe(1);
		expect((await saved(intent.attemptId)).result.metadata.phase).toBe(
			"transmitted",
		);
	},
);
it("records transport failure separately from generation commit failure", async () => {
	const api = service();
	const intent = await api.prepare(request, command);
	await expect(
		api.receive(recipient(intent.attemptId), async () => {
			sends++;
			throw new Error("controlled write failure");
		}),
	).rejects.toThrow();
	await assertNoReplay(api, intent.attemptId, "transport_failed", 1, 1);
});
it("does not restore the old credential after a committed rotation loses delivery", async () => {
	const api = service();
	const initial = await api.prepare(request, command);
	await api.receive(recipient(initial.attemptId), async () => {
		sends++;
	});
	const rotate = await api.prepare(
		{ ...request, idempotencyKey: "rotate" },
		{ ...command, operation: "rotate", credentialId: initial.credentialId },
	);
	const before =
		await sql`select revoked_at from platform.platform_api_credentials where id=${initial.credentialId}`;
	expect(before[0]?.revoked_at).toBe(null);
	await expect(
		api.receive(recipient(rotate.attemptId), async () => {
			sends++;
			throw new Error("controlled write failure");
		}),
	).rejects.toThrow();
	const keys =
		await sql`select id,revoked_at from platform.platform_api_credentials`;
	expect(
		keys.find((k) => k.id === initial.credentialId)?.revoked_at !== null,
	).toBe(true);
	expect(keys.find((k) => k.id === rotate.credentialId)?.revoked_at).toBe(null);
	await assertNoReplay(api, rotate.attemptId, "transport_failed", 2, 2);
});
it("does not revoke a replacement credential when the frozen rotation target drifts", async () => {
	const api = service();
	const initial = await api.prepare(request, command);
	await api.receive(recipient(initial.attemptId), async () => {
		sends++;
	});
	const pending = await api.prepare(
		{ ...request, idempotencyKey: "stale" },
		{ ...command, operation: "rotate", credentialId: initial.credentialId },
	);
	const replacement = await api.prepare(
		{ ...request, idempotencyKey: "replacement" },
		{ ...command, operation: "rotate", credentialId: initial.credentialId },
	);
	await api.receive(recipient(replacement.attemptId), async () => {
		sends++;
	});
	await expect(
		api.receive(recipient(pending.attemptId), async () => {
			sends++;
		}),
	).rejects.toThrow();
	const row =
		await sql`select revoked_at from platform.platform_api_credentials where id=${replacement.credentialId}`;
	expect(row[0]?.revoked_at).toBe(null);
	await assertNoReplay(api, pending.attemptId, "credential_changed", 2, 2);
});
it("rejects a foreign fence without changing the original transmitted receipt", async () => {
	const api = service();
	const intent = await api.prepare(request, command);
	await api.receive(recipient(intent.attemptId), async () => {
		sends++;
	});
	const before = await saved(intent.attemptId);
	await expect(
		api.confirm(recipient(intent.attemptId), {
			credentialId: intent.credentialId,
			fence: randomUUID(),
		}),
	).rejects.toMatchObject({ code: "not_found" });
	expect(await saved(intent.attemptId)).toEqual(before);
});
it("leaves confirmation unaccepted when its required audit rolls back", async () => {
	const api = service();
	const intent = await api.prepare(request, command);
	await api.receive(recipient(intent.attemptId), async () => {
		sends++;
	});
	const before = await saved(intent.attemptId);
	await sql`create function platform.reject_material_confirmation() returns trigger language plpgsql as $$ begin if NEW.action='application.credential.material.accepted' then raise exception 'controlled confirmation failure'; end if; return NEW; end $$`;
	await sql`create trigger reject_material_confirmation before insert on platform.audit_events for each row execute function platform.reject_material_confirmation()`;
	try {
		await expect(
			api.confirm(recipient(intent.attemptId), {
				credentialId: intent.credentialId,
				fence: before.result.metadata.fence!,
			}),
		).rejects.toThrow();
		expect((await saved(intent.attemptId)).result.delivery.status).not.toBe(
			"accepted",
		);
		expect((await saved(intent.attemptId)).failureReason).toBe(
			"confirmation_failed",
		);
		expect(sends).toBe(1);
		expect(inserts).toBe(1);
	} finally {
		await sql`drop trigger reject_material_confirmation on platform.audit_events`;
		await sql`drop function platform.reject_material_confirmation()`;
	}
});
it("a real process dying after claim commit cannot be resumed by another instance", async () => {
	const api = service();
	const intent = await api.prepare(request, command);
	const dir = await mkdtemp(join(tmpdir(), "material-crash-"));
	const childPath = join(dir, "receiver.mjs");
	const core = new URL("../../platform-core/dist/index.mjs", import.meta.url)
		.href;
	const adapter = new URL("../dist/index.mjs", import.meta.url).href;
	const script = `
 import {createApplicationCredentialMaterialDeliveryV1} from ${JSON.stringify(core)};
 import {PostgresApplicationCredentialMaterialStoreV1} from ${JSON.stringify(adapter)};
 const store=new PostgresApplicationCredentialMaterialStoreV1({databaseUrl:process.env.MATERIAL_TEST_DATABASE_URL});
 const wrapped={inspect:(...a)=>store.inspect(...a),execute:async work=>{let phase;const result=await store.execute(tx=>work({...tx,save:async r=>{phase=r.result.metadata.phase;await tx.save(r);},insertCredential:async(...a)=>{process.send({kind:'generated'});return tx.insertCredential(...a);}}));if(phase==='claimed'){await new Promise(resolve=>process.send({kind:'claimed'},resolve));process.kill(process.pid,'SIGKILL');}return result;}};
 const api=createApplicationCredentialMaterialDeliveryV1({store:wrapped,userDirectory:{resolveUser:async userId=>({schemaVersion:1,userId,accountStatus:'active',organizationIds:[],authorizationRevision:'identity-1'})},configuration:{schemaVersion:1,enabled:true,publicOrigin:'https://platform.example.test',recipients:[{applicationId:'app-1',principalType:'user',principalId:'recipient'}]}});
 await api.receive({applicationId:'app-1',attemptId:process.env.MATERIAL_TEST_ATTEMPT,userId:'recipient',requestId:'child',traceId:'trace'},async()=>{process.send({kind:'sent'});});
 `;
	await writeFile(childPath, script);
	const events: string[] = [];
	const child = fork(childPath, [], {
		execArgv: [],
		env: {
			...process.env,
			MATERIAL_TEST_DATABASE_URL: database.databaseUrl,
			MATERIAL_TEST_ATTEMPT: intent.attemptId,
		},
		stdio: ["ignore", "ignore", "ignore", "ipc"],
	});
	child.on("message", (message: unknown) => {
		if (message && typeof message === "object" && "kind" in message)
			events.push(String(message.kind));
	});
	try {
		const signal = await new Promise<NodeJS.Signals | null>(
			(resolve, reject) => {
				child.once("exit", (_code, signal) => resolve(signal));
				child.once("error", reject);
			},
		);
		expect(signal).toBe("SIGKILL");
		expect(events).toEqual(["claimed"]);
		const original = await saved(intent.attemptId);
		expect(original.result.metadata.phase).toBe("claimed");
		expect(original.result.delivery.status).toBe("delivery_in_flight");
		const recovery = await service().receive(
			recipient(intent.attemptId),
			async () => {
				sends++;
			},
		);
		expect(recovery.fence).toBe(original.result.metadata.fence);
		expect(recovery.replayed).toBe(true);
		expect(sends).toBe(0);
		expect(inserts).toBe(0);
		expect(
			await sql`select id from platform.platform_api_credentials`,
		).toHaveLength(0);
	} finally {
		child.kill("SIGKILL");
		await rm(dir, { recursive: true, force: true });
	}
});
it("records transmission commit acknowledgement loss without a second send", async () => {
	const api = service();
	const intent = await api.prepare(request, command);
	onceAfter("transmitted", async () => {
		throw new Error("controlled commit acknowledgement loss");
	});
	await expect(
		api.receive(recipient(intent.attemptId), async () => {
			sends++;
		}),
	).rejects.toThrow();
	await assertNoReplay(
		api,
		intent.attemptId,
		"transmission_commit_unconfirmed",
		1,
		1,
	);
});
