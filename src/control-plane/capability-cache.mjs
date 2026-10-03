import { ApiError } from '../admin/http.mjs';

const readers = new WeakMap();
const CAPABILITY_TTL_MS = 5_000;
const MAX_CENTERS = 32;

function unavailable(message = '无法确认中心服务版本，本次操作未执行') {
  return new ApiError(503, 'CONTROL_PLANE_UNAVAILABLE', message);
}

async function loadCapabilities(root, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${root}/health`, {
      method: 'GET', headers: { Accept: 'application/json' },
      cache: 'no-store', signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw unavailable();
  }
  if (!response.ok) {
    if ([404, 405].includes(response.status)) {
      throw new ApiError(503, 'CONTROL_PLANE_UPGRADE_REQUIRED', '中心服务版本过旧，已停止本次操作；请先完成中心服务升级');
    }
    throw unavailable('中心服务暂时不可用，本次操作未执行');
  }
  const health = await response.json().catch(() => null);
  const value = health?.data?.capabilities;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(503, 'CONTROL_PLANE_UPGRADE_REQUIRED', '中心服务版本过旧，已停止本次操作；请先完成中心服务升级');
  }
  return Object.freeze({ ...value });
}

// Only public version metadata is cached. Business responses and authorization
// never enter this cache; errors cannot extend a stale capability receipt.
export function createCapabilityReader({ fetchImpl = fetch, now = Date.now, ttlMs = CAPABILITY_TTL_MS,
  maxCenters = MAX_CENTERS } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs < 0 || !Number.isSafeInteger(maxCenters) || maxCenters < 1) {
    throw new TypeError('capability cache limits are invalid');
  }
  const centers = new Map();
  function invalidate(root) { centers.delete(root); }
  async function read(root) {
    const existing = centers.get(root);
    if (existing?.value && existing.expiresAt > now()) return existing.value;
    if (existing?.flight) return existing.flight;
    while (centers.size >= maxCenters) {
      const victim = [...centers].find(([, entry]) => !entry.flight)?.[0];
      if (victim === undefined) break;
      centers.delete(victim);
    }
    const entry = {};
    // When all bounded slots are active, still fail closed by doing an uncached
    // check rather than retaining an unbounded set of center addresses.
    const retained = centers.size < maxCenters;
    if (retained) centers.set(root, entry);
    entry.flight = loadCapabilities(root, fetchImpl).then(value => {
      if (centers.get(root) === entry) {
        entry.value = value;
        entry.expiresAt = now() + ttlMs;
      }
      return value;
    }).catch(error => {
      if (centers.get(root) === entry) centers.delete(root);
      throw error;
    }).finally(() => { entry.flight = null; });
    return entry.flight;
  }
  return { read, invalidate };
}

function readerFor(fetchImpl) {
  if (!readers.has(fetchImpl)) readers.set(fetchImpl, createCapabilityReader({ fetchImpl }));
  return readers.get(fetchImpl);
}

export function readControlPlaneCapabilities(root, { fetchImpl = fetch } = {}) {
  return readerFor(fetchImpl).read(root);
}

export function invalidateControlPlaneCapabilities(root, { fetchImpl = fetch } = {}) {
  readers.get(fetchImpl)?.invalidate(root);
}
