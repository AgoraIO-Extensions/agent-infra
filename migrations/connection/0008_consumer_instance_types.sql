ALTER TABLE connection_consumer_instances
  DROP CONSTRAINT connection_consumer_instances_kind_check;

UPDATE connection_consumer_instances instance
SET kind = 'TOKEN'
FROM connection_personal_access_tokens token
WHERE token.instance_id = instance.id;

UPDATE connection_consumer_instances
SET kind = CASE kind
	WHEN 'DIRECT' THEN 'DEVICE'
  WHEN 'DELEGATED' THEN 'WORKLOAD'
  ELSE kind
END;

ALTER TABLE connection_consumer_instances
  ADD CONSTRAINT connection_consumer_instances_kind_check
  CHECK (kind IN ('DEVICE', 'TOKEN', 'WORKLOAD'));

ALTER TABLE connection_consumer_instances
  ADD CONSTRAINT connection_consumer_instances_id_consumer_principal_key
  UNIQUE (id, consumer_id, principal_id);

ALTER TABLE connection_personal_access_tokens
  DROP CONSTRAINT connection_personal_access_tokens_principal_id_fkey,
  DROP CONSTRAINT connection_personal_access_tokens_consumer_id_fkey,
  DROP CONSTRAINT connection_personal_access_tokens_instance_id_fkey;

ALTER TABLE connection_personal_access_tokens
  ADD CONSTRAINT connection_personal_access_tokens_principal_id_fkey
  FOREIGN KEY (principal_id) REFERENCES connection_principals(id) ON DELETE RESTRICT,
  ADD CONSTRAINT connection_personal_access_tokens_consumer_id_fkey
  FOREIGN KEY (consumer_id) REFERENCES connection_consumers(id) ON DELETE RESTRICT,
  ADD CONSTRAINT connection_personal_access_tokens_instance_subject_fkey
  FOREIGN KEY (instance_id, consumer_id, principal_id)
  REFERENCES connection_consumer_instances (id, consumer_id, principal_id)
  ON DELETE RESTRICT;
