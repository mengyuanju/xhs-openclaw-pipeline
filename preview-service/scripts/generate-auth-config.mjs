import { pbkdf2Sync, randomBytes } from 'node:crypto';

const username = process.argv[2]?.trim() || 'admin';
const password = `Hm-${randomBytes(18).toString('base64url')}`;
const iterations = 600_000;
const salt = randomBytes(16);
const digest = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
const passwordHash = [
  'pbkdf2_sha256',
  String(iterations),
  salt.toString('base64url'),
  digest.toString('base64url'),
].join('$');

console.log(
  JSON.stringify(
    {
      username,
      password,
      passwordHash,
      note: 'The password is shown once. Store only passwordHash in the service secret.',
    },
    null,
    2,
  ),
);
