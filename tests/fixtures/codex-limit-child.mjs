import { createCodexRuntime } from '../../src/codex-runtime.mjs';
const [databasePath, imageFlag, total = '2', images = '1'] = process.argv.slice(2);
process.send({ type: 'ready' });
await new Promise((resolve) => process.once('message', resolve));
await createCodexRuntime({ databasePath, pollMs: 10, maxConcurrent: Number(total), maxConcurrentImages: Number(images) }).run(async () => {
  process.send({ type: 'entered', image: imageFlag === 'image' });
  await new Promise((resolve) => process.once('message', resolve));
}, { image: imageFlag === 'image' });
process.disconnect();
