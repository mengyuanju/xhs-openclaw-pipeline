-- Forward compatibility proof for the exact 0057 file applied to production
-- with one additional trailing newline. The recorded checksum remains intact;
-- this migration verifies that both file variants produced the same schema.
DO $compatibility$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute attribute
    WHERE attribute.attrelid = 'public.executor_nodes'::regclass
      AND attribute.attname = 'image_edit_executor_version'
      AND attribute.atttypid = 'integer'::regtype
      AND attribute.attnotnull
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'executor_nodes.image_edit_executor_version is missing or incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute attribute
    JOIN pg_attrdef default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.executor_nodes'::regclass
      AND attribute.attname = 'image_edit_executor_version'
      AND pg_get_expr(default_value.adbin, default_value.adrelid) = '0'
  ) THEN
    RAISE EXCEPTION 'executor_nodes.image_edit_executor_version default is incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'public.executor_nodes'::regclass
      AND constraint_row.contype = 'c'
      AND position(
        'image_edit_executor_version >= 0'
        IN pg_get_constraintdef(constraint_row.oid)
      ) > 0
  ) THEN
    RAISE EXCEPTION 'executor_nodes.image_edit_executor_version check constraint is missing';
  END IF;
END
$compatibility$;
