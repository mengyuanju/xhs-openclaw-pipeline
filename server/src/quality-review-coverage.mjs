const DATA_FIELDS = new Set([
  'batchId', 'qaBatchId', 'freezeId', 'samplingItemId', 'approvalId',
  'copyRevisionId', 'imageRunId', 'qualityCycle', 'sampleKind', 'selected',
  'exclusion', 'source', 'sourceEventId', 'triggerEventKey',
]);

function positiveInteger(value, name, nullable = false) {
  if (nullable && (value === null || value === undefined)) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError(`${name} is invalid`);
  return number;
}

function nonemptyKey(value, name) {
  if (typeof value !== 'string' || !value || value.length > 300 || /[\r\n]/u.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

// Coverage records contain identities and workflow metadata only. They survive
// content deletion and preserve repeated operations on the same review item.
export async function recordQualityReviewCoverage(client, {
  accountId = null, taskId, stage, reviewItemKey, kind, operationKey,
  occurredAt = null, data = {},
}) {
  if (!['COPY', 'IMAGE'].includes(stage)) throw new TypeError('stage is invalid');
  if (!['BATCH_RETURN', 'BATCH_RELEASE'].includes(kind)) throw new TypeError('kind is invalid');
  const itemKey = nonemptyKey(reviewItemKey, 'reviewItemKey');
  const operation = nonemptyKey(operationKey, 'operationKey');
  const at = occurredAt === null ? null : new Date(occurredAt).toISOString();
  const metadata = Object.fromEntries(Object.entries(data).filter(([key]) => DATA_FIELDS.has(key)));
  const result = await client.query(`INSERT INTO quality_review_coverage_events(
    event_key,account_id,task_id,stage,review_item_key,kind,occurred_at,operation_key,data)
    VALUES($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,now()),$8,$9::jsonb)
    ON CONFLICT(event_key) DO NOTHING`, [
    `coverage:${operation}:${itemKey}`, positiveInteger(accountId, 'accountId', true),
    positiveInteger(taskId, 'taskId'), stage, itemKey, kind, at, operation,
    JSON.stringify(metadata),
  ]);
  return result.rowCount === 1;
}
