-- #3378：只读导出最近若干分钟内各执行的阶段时间点，供 tests/stage-latency.mjs 汇总。
-- 只输出标识与时间，不读取事件正文。用法：psql -tA -v minutes=30 -f tests/stage-latency.sql
begin transaction read only;

select coalesce(json_agg(row_to_json(t) order by t."acceptedAt"), '[]'::json)
from (
	select
		x.execution_id as "executionId",
		x.channel_id as "channelId",
		x.status,
		x.created_at as "acceptedAt",
		(select min(e.persisted_at) from platform.conversation_events e
			where e.execution_id = x.execution_id and e.event_type = 'text.delta') as "firstTextAt",
		terminal.occurred_at as "terminalOccurredAt",
		terminal.persisted_at as "terminalPersistedAt",
		(select max(r.updated_at) from platform.wecom_receipts r
			where r.execution_id = x.execution_id and r.delivery_status = 'sent') as "deliveredAt"
	from platform.conversation_executions x
	left join lateral (
		select e.occurred_at, e.persisted_at
		from platform.conversation_events e
		where e.execution_id = x.execution_id
			and e.event_type = 'execution.status'
			and e.event_payload->>'status' in ('completed', 'failed', 'cancelled')
		order by e.sequence desc
		limit 1
	) terminal on true
	where x.created_at >= now() - make_interval(mins => :minutes)
) t;

rollback;
