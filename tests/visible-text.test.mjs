import assert from 'node:assert/strict';
import test from 'node:test';

import { imagePlanBulletCount, visibleCharacterCount } from '../src/visible-text.mjs';

test('image plan bullets count continuous English letters as one unit', () => {
  const task597Bullet = '第三方录像机选ONVIF，填写摄像头IP、账号、密码和端口80';

  assert.equal(visibleCharacterCount(task597Bullet), 31);
  assert.equal(imagePlanBulletCount(task597Bullet), 26);
  assert.equal(imagePlanBulletCount('ONVIF，IP 80'), 6);
  assert.equal(imagePlanBulletCount('Wi-Fi'), 3);
  assert.equal(imagePlanBulletCount('字 ❤️ e\u0301 80。'), 9);
});
