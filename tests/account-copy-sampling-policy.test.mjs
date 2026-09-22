import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCopySamplingRateOverride, resolveEffectiveCopySamplingPolicy } from '../src/copy-sampling-policy.mjs';
import { accountSamplingInputBps, accountSamplingLabel, accountSamplingSettings } from '../app/users/copy-sampling-settings.ts';
import { assertMutationCapability, requiredMutationCapability } from '../src/control-plane/mutation-capability.mjs';

const defaults = { globalEnabled: true, globalRateBps: 2000, globalPolicyVersion: 7, accountVersion: 3 };

test('account policy preserves explicit zero, inheritance, versions and the global switch', () => {
  const inherited = resolveEffectiveCopySamplingPolicy(defaults);
  assert.deepEqual(inherited, { enabled: true, rateBps: 2000, rateSource: 'GLOBAL_DEFAULT', globalPolicyVersion: 7, accountPolicyVersion: 3 });
  for (const rate of [0, 1, 5000, 9999, 10000]) {
    assert.equal(normalizeCopySamplingRateOverride(rate), rate);
    assert.deepEqual(resolveEffectiveCopySamplingPolicy({ ...defaults, accountRateBpsOverride: rate }), {
      ...inherited, rateBps: rate, rateSource: 'ACCOUNT_OVERRIDE',
    });
    assert.equal(resolveEffectiveCopySamplingPolicy({ ...defaults, globalEnabled: false, accountRateBpsOverride: rate }).enabled, false);
  }
  assert.equal(resolveEffectiveCopySamplingPolicy({ ...defaults, globalEnabled: false }).rateSource, 'GLOBAL_DISABLED');
  assert.equal(resolveEffectiveCopySamplingPolicy({ ...defaults, accountVersion: null }).accountPolicyVersion, null);
  for (const invalid of [-1, 10001, 1.5, '2000', '', false, {}, NaN, Infinity, undefined]) {
    assert.throws(() => normalizeCopySamplingRateOverride(invalid));
  }
});

test('admin inputs distinguish blank from zero and labels preserve default, disabled and unavailable states', () => {
  for (const [input, expected] of [['0', 0], ['0.01', 1], ['0.29', 29], ['12.34', 1234], ['100', 10000]]) {
    assert.equal(accountSamplingInputBps(input), expected);
  }
  for (const invalid of ['', ' ', '-1', '101', '12.345', '1e2', 'NaN']) assert.throws(() => accountSamplingInputBps(invalid));
  const settings = accountSamplingSettings({ capabilities: { copySamplingVersion: 2 } }, { version: 1, copySampling: { enabled: true, rateBps: 2000 } });
  assert.match(accountSamplingLabel(settings, null), /继承 · 20%/u);
  assert.match(accountSamplingLabel(settings, 0), /单独 · 0%（尾批保底）/u);
  assert.match(accountSamplingLabel({ ...settings, enabled: false }, 5000), /单独 · 50% · 暂不生效/u);
  assert.match(accountSamplingLabel(settings, undefined), /未读取/u);
  assert.match(accountSamplingLabel({ ...settings, supported: false }, null), /尚未支持/u);
  assert.equal(accountSamplingSettings({}, {}), null);
});

test('only writes containing the override require center V2, including explicit null and zero', async () => {
  for (const [routePath, method] of [['/v1/users', 'POST'], ['/v1/users/2', 'PATCH']]) {
    assert.equal(requiredMutationCapability(routePath, method, {}), null);
    for (const value of [null, 0, 5000]) {
      const body = { copySamplingRateBpsOverride: value };
      assert.deepEqual(requiredMutationCapability(routePath, method, body), { capability: 'copySamplingVersion', minimumVersion: 2 });
      for (const available of [undefined, 1, 2]) {
        const call = () => assertMutationCapability({ root: 'http://fake', routePath, method, body,
          fetchImpl: async () => Response.json({ data: { capabilities: { copySamplingVersion: available } } }) });
        if (available === 2) await call();
        else await assert.rejects(call, { code: 'CONTROL_PLANE_UPGRADE_REQUIRED' });
      }
    }
  }
});
