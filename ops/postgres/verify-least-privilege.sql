-- Fails under psql when the fixed application roles have unsafe schema or table privileges.
DO $$
DECLARE
  violation text;
BEGIN
  IF has_schema_privilege('kings_runtime', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'kings_runtime must not have CREATE on schema public';
  END IF;
  IF has_schema_privilege('kings_backup', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'kings_backup must not have CREATE on schema public';
  END IF;
  IF has_database_privilege('kings_runtime', current_database(), 'CREATE') OR
     has_database_privilege('kings_backup', current_database(), 'CREATE') THEN
    RAISE EXCEPTION 'runtime and backup roles must not create schemas';
  END IF;
  SELECT format('%I.%I grants %s to kings_backup', table_schema, table_name, privilege_type)
    INTO violation
    FROM information_schema.role_table_grants
   WHERE grantee = 'kings_backup'
     AND table_schema = 'public'
     AND privilege_type <> 'SELECT'
   LIMIT 1;
  IF violation IS NOT NULL THEN RAISE EXCEPTION '%', violation; END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE grantee = 'kings_runtime' AND table_schema = 'public' AND privilege_type = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'kings_runtime has no table access';
  END IF;
END $$;
