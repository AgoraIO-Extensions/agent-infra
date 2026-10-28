import { writeFile } from "node:fs/promises";
import postgres from "postgres";
import { expect, it } from "vitest";
import { migratePlatformDatabase } from "./migrate.js";
import { startPostgresTestDatabase } from "./postgres-test.js";

it("records actual window and model metadata plans among unrelated principals, Agents and text events", async () => {
	const database = await startPostgresTestDatabase("evaluation-query-plan");
	const sql = postgres(database.databaseUrl, { max: 1, onnotice: () => {} });
	try {
		await migratePlatformDatabase(database);
		await sql`insert into platform.conversations(id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision) select 'perf-'||n,case when n%3=0 then 'other-agent' else 'selected-agent' end,case when n%3=1 then 'self' else 'other' end,'web','active',1,'perf' from generate_series(1,6000)n`;
		await sql`insert into platform.conversation_executions(execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,delivery_fence,authorization_revision,created_at)select id,id,agent_id,actor_id,channel_id,id,'completed',1,1,'perf',clock_timestamp() from platform.conversations where id like 'perf-%'`;
		const [cutoff] = await sql<{ at: Date }[]>`select clock_timestamp() as at`;
		await sql`insert into platform.conversations(id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision)values('selected','selected-agent','self','web','active',1,'perf')`;
		await sql`insert into platform.conversation_executions(execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,delivery_fence,authorization_revision,created_at,last_event_sequence)values('selected','selected','selected-agent','self','web','selected','completed',1,1,'perf',clock_timestamp(),4001)`;
		await sql`insert into platform.conversation_events(event_id,conversation_id,execution_id,sequence,conversation_cursor,event_type,event_payload,source,adapter_event_key,event_digest,runtime_cursor,occurred_at)select 'text-'||n,'selected','selected',n,n,'text.delta',jsonb_build_object('type','text.delta','text',repeat('synthetic-private-text',100)),'runtime','text-'||n,repeat('a',64),n::text,clock_timestamp() from generate_series(1,4000)n`;
		await sql`insert into platform.conversation_events(event_id,conversation_id,execution_id,sequence,conversation_cursor,event_type,event_payload,source,adapter_event_key,event_digest,runtime_cursor,occurred_at)values('model','selected','selected',4001,4001,'execution.operation','{"schemaVersion":2,"type":"execution.operation","fact":{"kind":"model","operationRef":"op","attemptRef":"attempt","phase":"started","model":{"configVersion":"1","modelOptionId":"one","modelId":"actual"}}}'::jsonb,'runtime','model',repeat('b',64),'4001',clock_timestamp())`;
		await sql`analyze platform.conversation_executions`;
		await sql`analyze platform.conversation_events`;
		const self =
			await sql`explain(analyze,buffers,format json) select execution_id from platform.conversation_executions where agent_id='selected-agent' and principal_type='user' and actor_id='self' and terminal_observed_at>=${cutoff?.at} and terminal_observed_at<clock_timestamp()+interval '1 second' and status in ('completed','failed','cancelled') order by terminal_observed_at,execution_id limit 101`;
		const owner =
			await sql`explain(analyze,buffers,format json) select execution_id from platform.conversation_executions where agent_id='selected-agent' and terminal_observed_at>=${cutoff?.at} and terminal_observed_at<clock_timestamp()+interval '1 second' and status in ('completed','failed','cancelled') order by terminal_observed_at,execution_id limit 101`;
		const model =
			await sql`explain(analyze,buffers,format json) select sequence,event_payload->'fact' from platform.conversation_events where execution_id='selected' and sequence<=4001 and source='runtime' and event_type='execution.operation' and event_payload->'fact'->>'kind'='model' order by sequence limit 101`;
		const coverage =
			await sql`explain(analyze,buffers,format json) select execution_id from platform.conversation_executions where agent_id='selected-agent' and principal_type='user' and actor_id='self' and status in ('completed','failed','cancelled') and (terminal_observed_at is null or (terminal_observed_at>=${cutoff?.at} and terminal_observed_at<clock_timestamp()+interval '1 second')) order by terminal_observed_at nulls last,execution_id limit 101`;
		const plans = {
			fixture: { executions: 6001, textEvents: 4000, modelFacts: 1 },
			coverage: coverage[0]?.["QUERY PLAN"],
			self: self[0]?.["QUERY PLAN"],
			owner: owner[0]?.["QUERY PLAN"],
			model: model[0]?.["QUERY PLAN"],
		};
		for (const plan of [plans.self, plans.owner, plans.model, plans.coverage])
			expect(plan?.[0]?.Plan["Actual Rows"]).toBe(1);
		if (process.env.EVALUATION_QUERY_PLAN_RECEIPT)
			await writeFile(
				process.env.EVALUATION_QUERY_PLAN_RECEIPT,
				JSON.stringify(plans, null, 2),
			);
	} finally {
		await sql.end();
		await database.stop();
	}
}, 120000);
