ALTER TABLE copy_qa_batches_v2 ADD COLUMN display_name text;

WITH numbered AS (
  SELECT id,
    (created_at AT TIME ZONE 'Asia/Shanghai')::date AS batch_day,
    row_number() OVER (
      PARTITION BY (created_at AT TIME ZONE 'Asia/Shanghai')::date
      ORDER BY created_at,id
    ) AS day_number
  FROM copy_qa_batches_v2
)
UPDATE copy_qa_batches_v2 AS batch SET display_name =
  '文案质检-' || to_char(numbered.batch_day,'YYYYMMDD') || '-'
  || lpad(numbered.day_number::text,greatest(3,length(numbered.day_number::text)),'0')
FROM numbered WHERE numbered.id=batch.id;

CREATE TABLE copy_qa_batch_daily_counters (
  batch_day date PRIMARY KEY,
  last_number bigint NOT NULL CHECK (last_number > 0)
);

INSERT INTO copy_qa_batch_daily_counters(batch_day,last_number)
SELECT batch_day,max(day_number)
FROM (
  SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date AS batch_day,
    row_number() OVER (
      PARTITION BY (created_at AT TIME ZONE 'Asia/Shanghai')::date
      ORDER BY created_at,id
    ) AS day_number
  FROM copy_qa_batches_v2
) AS numbered
GROUP BY batch_day;

CREATE FUNCTION next_copy_qa_batch_display_name() RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  local_batch_day date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  day_number bigint;
BEGIN
  INSERT INTO copy_qa_batch_daily_counters(batch_day,last_number)
  VALUES(local_batch_day,1)
  ON CONFLICT(batch_day) DO UPDATE
    SET last_number=copy_qa_batch_daily_counters.last_number+1
  RETURNING last_number INTO day_number;
  RETURN '文案质检-' || to_char(local_batch_day,'YYYYMMDD') || '-'
    || lpad(day_number::text,greatest(3,length(day_number::text)),'0');
END $$;

ALTER TABLE copy_qa_batches_v2
  ALTER COLUMN display_name SET DEFAULT next_copy_qa_batch_display_name(),
  ALTER COLUMN display_name SET NOT NULL;

CREATE UNIQUE INDEX copy_qa_batches_v2_display_name_idx
  ON copy_qa_batches_v2(display_name);
