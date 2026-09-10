import { createHash } from 'node:crypto';

export const COPY_SAMPLING_ALGORITHM_VERSION = 'stratified-largest-remainder-v1';

function positiveInteger(value, name) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return normalized;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function contentHash(value) {
  const normalized = String(value ?? '').toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new TypeError('contentSha256 must be a SHA-256 digest');
  }
  return normalized;
}

function normalizedSeed(value) {
  const seed = String(value ?? '').trim();
  if (!seed || Buffer.byteLength(seed, 'utf8') > 200) {
    throw new TypeError('seed must contain between 1 and 200 bytes');
  }
  return seed;
}

function normalizePopulation(population) {
  if (!Array.isArray(population) || population.length < 1 || population.length > 100_000) {
    throw new RangeError('population must contain between 1 and 100000 items');
  }
  const normalized = population.map((item, index) => ({
    taskId: positiveInteger(item?.taskId, `population[${index}].taskId`),
    copyRevisionId: positiveInteger(item?.copyRevisionId, `population[${index}].copyRevisionId`),
    approvalEventId: positiveInteger(item?.approvalEventId, `population[${index}].approvalEventId`),
    finalApproverAccountId: positiveInteger(
      item?.finalApproverAccountId,
      `population[${index}].finalApproverAccountId`,
    ),
    contentSha256: contentHash(item?.contentSha256),
  }));
  if (new Set(normalized.map((item) => item.taskId)).size !== normalized.length) {
    throw new TypeError('population task ids must be unique');
  }
  if (new Set(normalized.map((item) => item.approvalEventId)).size !== normalized.length) {
    throw new TypeError('population approval event ids must be unique');
  }
  return normalized.toSorted((left, right) => left.taskId - right.taskId);
}

function sampleTarget(populationCount, rateBps) {
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000) {
    throw new RangeError('rateBps must be an integer between 0 and 10000');
  }
  if (rateBps === 0) return 0;
  return Math.ceil((populationCount * rateBps) / 10_000);
}

function allocateQuotas(groups, target, populationCount, seed) {
  const strata = [...groups.entries()].map(([accountId, items]) => {
    const numerator = items.length * target;
    return {
      finalApproverAccountId: accountId,
      populationCount: items.length,
      quota: Math.floor(numerator / populationCount),
      remainder: numerator % populationCount,
      tieHash: sha256(`${COPY_SAMPLING_ALGORITHM_VERSION}\0${seed}\0${accountId}`),
    };
  });
  let outstanding = target - strata.reduce((total, stratum) => total + stratum.quota, 0);
  for (const stratum of strata.toSorted((left, right) => (
    right.remainder - left.remainder
      || left.tieHash.localeCompare(right.tieHash)
      || left.finalApproverAccountId - right.finalApproverAccountId
  ))) {
    if (outstanding === 0) break;
    stratum.quota += 1;
    outstanding -= 1;
  }
  return strata
    .map(({ remainder: _remainder, tieHash: _tieHash, ...stratum }) => stratum)
    .toSorted((left, right) => left.finalApproverAccountId - right.finalApproverAccountId);
}

/**
 * Select an exact, reproducible sample from the final manually-approved copy
 * revisions. The caller persists every returned member, including non-samples.
 */
export function selectStratifiedCopySample({ population, rateBps, seed }) {
  const members = normalizePopulation(population);
  const normalizedSamplingSeed = normalizedSeed(seed);
  const target = sampleTarget(members.length, rateBps);
  const groups = new Map();
  for (const member of members) {
    const group = groups.get(member.finalApproverAccountId) ?? [];
    group.push(member);
    groups.set(member.finalApproverAccountId, group);
  }
  const strata = allocateQuotas(groups, target, members.length, normalizedSamplingSeed);
  const quotaByAccount = new Map(strata.map((stratum) => [stratum.finalApproverAccountId, stratum.quota]));
  const ranked = [];
  for (const [accountId, group] of groups) {
    const ordered = group.map((member) => ({
      ...member,
      rankHash: sha256([
        COPY_SAMPLING_ALGORITHM_VERSION,
        normalizedSamplingSeed,
        member.taskId,
        member.copyRevisionId,
        member.approvalEventId,
        member.contentSha256,
      ].join('\0')),
    })).toSorted((left, right) => left.rankHash.localeCompare(right.rankHash) || left.taskId - right.taskId);
    const quota = quotaByAccount.get(accountId) ?? 0;
    ranked.push(...ordered.map((member, index) => ({ ...member, selected: index < quota })));
  }
  const selectedMembers = ranked.filter((member) => member.selected);
  if (selectedMembers.length !== target) throw new Error('copy sampling quota invariant failed');
  const sortedMembers = ranked.toSorted((left, right) => left.taskId - right.taskId);
  const snapshotSha256 = sha256(JSON.stringify({
    algorithmVersion: COPY_SAMPLING_ALGORITHM_VERSION,
    rateBps,
    seed: normalizedSamplingSeed,
    strata,
    members: sortedMembers.map(({ rankHash, selected, ...member }) => ({ ...member, rankHash, selected })),
  }));
  return {
    algorithmVersion: COPY_SAMPLING_ALGORITHM_VERSION,
    rateBps,
    seed: normalizedSamplingSeed,
    populationCount: members.length,
    sampleCount: target,
    snapshotSha256,
    strata,
    members: sortedMembers,
  };
}
