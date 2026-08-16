import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { updateAuthEnvironmentFile } from '../src/admin/auth-setup.mjs';

describe('admin authentication environment setup', () => {
  it('preserves unrelated settings while replacing auth values exactly once', () => {
    const existing = [
      '# local settings',
      'OPENCLAW_MODEL=existing-model',
      'XHS_SESSION_SECRET=old-secret',
      'XHS_ADMIN_PASSWORD_HASH=old-hash',
      'XHS_SESSION_SECRET=duplicate-old-secret',
      '',
    ].join('\r\n');

    const updated = updateAuthEnvironmentFile(existing, {
      passwordHash: 'scrypt-v1.new-salt.new-digest',
      sessionSecret: 'new-session-secret',
    });

    assert.match(updated, /OPENCLAW_MODEL=existing-model/);
    assert.equal((updated.match(/^XHS_ADMIN_PASSWORD_HASH=/gm) || []).length, 1);
    assert.equal((updated.match(/^XHS_SESSION_SECRET=/gm) || []).length, 1);
    assert.match(updated, /^XHS_ADMIN_PASSWORD_HASH=scrypt-v1\.new-salt\.new-digest$/m);
    assert.match(updated, /^XHS_SESSION_SECRET=new-session-secret$/m);
    assert.match(updated, /\r\n/);
  });

  it('appends auth settings to a new environment file', () => {
    const updated = updateAuthEnvironmentFile('', {
      passwordHash: 'scrypt-v1.salt.digest',
      sessionSecret: 'session-secret',
    });

    assert.equal(updated, [
      'XHS_ADMIN_PASSWORD_HASH=scrypt-v1.salt.digest',
      'XHS_SESSION_SECRET=session-secret',
      '',
    ].join('\n'));
  });

  it('rejects values that could inject additional environment entries', () => {
    assert.throws(() => updateAuthEnvironmentFile('', {
      passwordHash: 'hash\nUNSAFE=value',
      sessionSecret: 'safe-value',
    }), /environment value/i);
  });
});
