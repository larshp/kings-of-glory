-- Run as the schema owner after migrations. Roles must already exist and receive passwords through
-- the deployment secret manager. Override the search_path before running if the application schema
-- is not public.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM kings_runtime, kings_backup;
GRANT USAGE ON SCHEMA public TO kings_runtime, kings_backup;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kings_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kings_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO kings_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO kings_backup;

ALTER DEFAULT PRIVILEGES FOR ROLE kings_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kings_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE kings_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO kings_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE kings_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO kings_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE kings_migrator IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO kings_backup;

DO $$
BEGIN
  EXECUTE format(
    'REVOKE TEMPORARY ON DATABASE %I FROM kings_runtime, kings_backup',
    current_database()
  );
END $$;
