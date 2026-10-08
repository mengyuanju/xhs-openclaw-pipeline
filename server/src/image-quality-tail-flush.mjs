const TAIL_MS = 30 * 60_000;
const WINDOW_SIZE = 20;

// A batch's earliest task is a conservative ordering bound: deterministic
// sampling may select any later task, so equal bounds must also be frozen.
export function createImageQualityTailDrain({ pool, readSettings, freeze, onError = () => {} }) {
  const drains = new Map();
  const batches = new Map();
  const waiters = [];
  let active = 0;
  let stopping = false;

  async function freezeBatch(row, now) {
    const key = `${row.production_batch_id}:${row.submitted_by_account_id}`;
    if (batches.has(key)) return batches.get(key);
    const inFlight = Promise.resolve().then(async () => {
      if (active >= 2) await new Promise(resolve => waiters.push(resolve));
      else active++;
      try { return stopping ? null : await freeze(row, now); }
      finally {
        const next = waiters.shift();
        if (next) next(); else active--;
        batches.delete(key);
      }
    });
    batches.set(key, inFlight);
    return inFlight;
  }

  async function candidates(now, { excludeAccountId = null, personName = null, actionableOnly = false } = {}, boundary = null, limit = WINDOW_SIZE) {
    return (await pool.query(`
      SELECT task.production_batch_id, approval.submitted_by_account_id,
        min(task.priority_sort_at) FILTER (WHERE NOT $6::boolean OR NOT task.priority_paused) AS earliest_priority
      FROM image_approval_events AS approval
      JOIN tasks AS task ON task.id = approval.task_id AND task.state = 'IMAGE_QC_PENDING'
        AND task.current_copy_revision_id = approval.copy_revision_id
        AND task.current_image_run_id = approval.image_run_id
      WHERE ($2::bigint IS NULL OR approval.submitted_by_account_id <> $2)
        AND ($3::varchar IS NULL OR strpos(lower(approval.submitted_by_username), lower($3)) > 0
          OR EXISTS (SELECT 1 FROM app_users person_filter
            WHERE person_filter.id = approval.submitted_by_account_id
              AND strpos(lower(person_filter.display_name), lower($3)) > 0))
        AND NOT EXISTS (SELECT 1 FROM image_sampling_items item WHERE item.approval_event_id = approval.id)
        AND NOT EXISTS (SELECT 1 FROM image_approval_events newer
          WHERE newer.task_id = approval.task_id AND newer.image_run_id = approval.image_run_id
            AND (newer.submitted_at, newer.id) > (approval.submitted_at, approval.id))
      GROUP BY task.production_batch_id, approval.submitted_by_account_id
      HAVING min(approval.submitted_at) <= $1
        AND (NOT $6::boolean OR bool_or(NOT task.priority_paused))
        AND ($5::timestamptz IS NULL OR min(task.priority_sort_at)
          FILTER (WHERE NOT $6::boolean OR NOT task.priority_paused) <= $5)
      ORDER BY earliest_priority, task.production_batch_id, approval.submitted_by_account_id
      LIMIT $4
    `, [new Date(now.valueOf() - TAIL_MS), excludeAccountId, personName, limit, boundary, actionableOnly])).rows;
  }

  async function pageBoundary({ actor, status, personName, actionableOnly, limit, offset }) {
    return (await pool.query(`
      SELECT task.priority_sort_at
      FROM image_sampling_items item
      JOIN tasks task ON task.id = item.task_id
      JOIN image_approval_events approval ON approval.id = item.approval_event_id
      JOIN image_runs image_run ON image_run.id = item.image_run_id AND image_run.task_id = item.task_id
      WHERE item.selected AND ($2 = 'ALL' OR item.status = $2)
        AND ($5 = 'ADMIN' OR item.submitter_account_id <> $1)
        AND ($3::varchar IS NULL OR strpos(lower(item.submitter_username), lower($3)) > 0
          OR EXISTS (SELECT 1 FROM app_users person_filter WHERE person_filter.id = item.submitter_account_id
            AND strpos(lower(person_filter.display_name), lower($3)) > 0))
        AND (NOT $6::boolean OR (item.status = 'PENDING' AND NOT task.priority_paused
          AND item.approval_event_id = (SELECT current_approval.id FROM image_approval_events current_approval
            WHERE current_approval.task_id = item.task_id AND current_approval.image_run_id = item.image_run_id
            ORDER BY current_approval.submitted_at DESC, current_approval.id DESC LIMIT 1)))
      ORDER BY task.priority_sort_at, item.id LIMIT 1 OFFSET $4
    `, [actor.userId, status, personName, offset + limit - 1, actor.role, Boolean(actionableOnly)])).rows[0]?.priority_sort_at ?? null;
  }

  function share(key, run) {
    if (stopping) return Promise.resolve([]);
    if (drains.has(key)) return drains.get(key);
    const inFlight = Promise.resolve().then(run).finally(() => drains.delete(key));
    drains.set(key, inFlight);
    return inFlight;
  }

  return {
    flush({ now = new Date(), limit = WINDOW_SIZE } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > WINDOW_SIZE) throw new RangeError('image QA tail limit must be from 1 to 20');
      return share('background', async () => {
        const settings = await readSettings();
        if (!settings.imageSampling.enabled || settings.imageSampling.rateBps === 0 || stopping) return [];
        const rows = await candidates(now, {}, null, limit);
        const frozen = [];
        for (const row of rows) {
          if (stopping) break;
          const result = await freezeBatch(row, now);
          if (result) frozen.push(result);
        }
        return frozen;
      });
    },
    flushForPage(options) {
      // New automatic tails create PENDING items only. A public item identifier
      // already names an existing freeze and needs no automatic tail maintenance.
      if (options.itemPublicId != null || !['PENDING', 'ALL'].includes(options.status)) return Promise.resolve([]);
      const key = JSON.stringify(['page', options]);
      return share(key, async () => {
        const settings = await readSettings();
        if (!settings.imageSampling.enabled || settings.imageSampling.rateBps === 0) return [];
        const scope = { excludeAccountId: options.actor.role === 'ADMIN' ? null : options.actor.userId,
          personName: options.personName, actionableOnly: Boolean(options.actionableOnly) };
        const now = new Date();
        const frozen = [];
        while (!stopping) {
          const boundary = await pageBoundary(options);
          const rows = await candidates(now, scope, boundary);
          if (!rows.length) break;
          let changed = false;
          let windowBoundary = boundary;
          let previousPriority = null;
          for (const row of rows) {
            if (stopping) break;
            const earliest = new Date(row.earliest_priority).valueOf();
            if (previousPriority !== null && earliest !== previousPriority) windowBoundary = await pageBoundary(options);
            if (windowBoundary !== null && earliest > new Date(windowBoundary).valueOf()) break;
            previousPriority = earliest;
            const result = await freezeBatch(row, now);
            if (result) { changed = true; frozen.push(result); }
          }
          // Concurrent consumers can move the page boundary. Re-read it even
          // when this request froze nothing; disabled sampling ends the drain.
          if (!changed) {
            const current = await readSettings();
            if (!current.imageSampling.enabled || current.imageSampling.rateBps === 0) break;
          }
        }
        return frozen;
      });
    },
    async dispose() {
      stopping = true;
      const results = await Promise.allSettled([...drains.values(), ...batches.values()]);
      for (const result of results) if (result.status === 'rejected') onError(result.reason);
    },
  };
}
