-- #3456：Platform DB 只跑按索引读写少量行的短事务。JIT 按估算成本触发，估算偏高的小查询每次都要
-- 多付几百毫秒到两秒的编译时间，没有收益。对新连接生效；账号无权修改数据库参数时只提示，不阻断迁移。
DO $$
BEGIN
	EXECUTE format('ALTER DATABASE %I SET jit = off', current_database());
EXCEPTION WHEN insufficient_privilege THEN
	RAISE NOTICE 'jit stays at the server default: %', SQLERRM;
END
$$;
