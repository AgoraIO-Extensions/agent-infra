ALTER TABLE connection_consumer_action_declarations
  ADD CONSTRAINT connection_consumer_declarations_provider_release_fkey
  FOREIGN KEY (provider_release_id, provider_id)
  REFERENCES connection_provider_releases (id, provider)
  ON DELETE RESTRICT;
