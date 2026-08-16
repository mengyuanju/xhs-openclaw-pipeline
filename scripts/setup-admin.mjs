import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashAdminPassword } from '../src/admin/auth.mjs';
import { updateAuthEnvironmentFile } from '../src/admin/auth-setup.mjs';

function readHiddenLine(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('当前终端不支持隐藏输入；自动化请使用 --password-stdin');
  }
  process.stdout.write(prompt);
  process.stdin.setEncoding('utf8');
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise((resolveInput, rejectInput) => {
    let value = '';
    const finish = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          finish();
          rejectInput(new Error('已取消管理员配置'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          resolveInput(value);
          return;
        }
        if (character === '\b' || character === '\u007f') {
          value = Array.from(value).slice(0, -1).join('');
          continue;
        }
        value += character;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function readPasswords(args) {
  if (args.length === 0) {
    return [
      await readHiddenLine('设置管理员密码（至少 12 位）：'),
      await readHiddenLine('再次输入管理员密码：'),
    ];
  }
  if (args.length === 1 && args[0] === '--password-stdin') {
    const lines = (await readFile(0, 'utf8')).replaceAll('\r', '').split('\n');
    return [lines[0] || '', lines[1] || ''];
  }
  throw new Error('仅支持无参数交互模式或 --password-stdin；不要把密码放在命令行参数中');
}

async function main() {
  const [password, confirmation] = await readPasswords(process.argv.slice(2));
  if (password !== confirmation) throw new Error('两次输入的密码不一致');

  const passwordHash = await hashAdminPassword(password);
  const sessionSecret = randomBytes(48).toString('base64url');
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const environmentPath = resolve(projectRoot, '.env.local');
  let existing = '';
  try {
    existing = await readFile(environmentPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const updated = updateAuthEnvironmentFile(existing, { passwordHash, sessionSecret });
  await writeFile(environmentPath, updated, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write('管理员凭据已安全更新。请重启后台使配置生效。\n');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : '管理员配置失败'}\n`);
  process.exitCode = 1;
});
