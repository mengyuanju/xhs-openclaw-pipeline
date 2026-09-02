import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createRunId } from '../app/image-generation/run-id.ts';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe('createRunId', () => {
  it('uses the browser native UUID generator when it is available', () => {
    const expected = '12345678-1234-4123-8123-123456789abc';

    assert.equal(createRunId({ randomUUID: () => expected }), expected);
  });

  it('creates a valid UUID v4 when crypto.randomUUID is unavailable', () => {
    const cryptoWithoutRandomUUID = {
      getRandomValues(values) {
        values.set([
          0x00, 0x01, 0x02, 0x03,
          0x04, 0x05, 0x06, 0x07,
          0x08, 0x09, 0x0a, 0x0b,
          0x0c, 0x0d, 0x0e, 0x0f,
        ]);
        return values;
      },
    };

    const runId = createRunId(cryptoWithoutRandomUUID);

    assert.equal(runId, '00010203-0405-4607-8809-0a0b0c0d0e0f');
    assert.match(runId, UUID_V4);
  });

  it('creates a valid UUID v4 when Web Crypto is unavailable on LAN HTTP', () => {
    const runId = createRunId(null, () => 0.5);

    assert.equal(runId, '80808080-8080-4080-8080-808080808080');
    assert.match(runId, UUID_V4);
  });
});
