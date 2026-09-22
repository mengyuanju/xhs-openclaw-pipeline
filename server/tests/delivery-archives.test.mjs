import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import { inspectDeliverySources, writeDeliveryAggregate } from '../src/delivery-archives.mjs';
import { buildBatchTaskArchive } from '../src/task-archive.mjs';
import { withOriginalDeliveryQuery } from '../src/delivery-copy-query.mjs';

async function storage(t) {
  const root = await mkdtemp(join(tmpdir(), 'xhs-delivery-archive-test-'));
  t.after(async () => {
    assert.ok(root.startsWith(join(tmpdir(), 'xhs-delivery-archive-test-')));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await mkdir(join(root, '.delivery-batches'));
  return root;
}

async function saveSource(root, bytes, taskIds = [1]) {
  const publicId = randomUUID();
  await writeFile(join(root, '.delivery-batches', `${publicId}.zip`), bytes);
  return taskIds.map(taskId => ({
    item_id: taskId, task_id: taskId, copy_revision_id: taskId + 10, image_run_id: randomUUID(),
    batch_public_id: publicId, batch_code: 'JF-TEST', source_byte_size: bytes.length,
    source_sha256: createHash('sha256').update(bytes).digest('hex'), query: `Query ${taskId}`,
  }));
}

function job() {
  return { id: 1, run_token: randomUUID(), kind: 'DOWNLOAD', actor_role: 'ADMIN', actor_account_id: 1, actor_username: 'admin' };
}

test('aggregate extracts selected task files from new batch folders with unchanged bytes', async t => {
  const root = await storage(t);
  const tasks = [1, 2].map(id => ({
    id, query: `Query ${id}`, currentCopyRevisionId: id + 10, currentImageRunId: `run-${id}`,
    copyRevisions: [{ id: id + 10, content: { copy: { title: '相同标题', body: `正文${id}` } } }],
    imageRuns: [{ id: `run-${id}`, result: { images: [{ assetId: id }] } }],
    assets: [{ id, imageRunId: `run-${id}`, mediaType: 'image/png' }],
    xiaohongshuSearchStatus: 'SUCCEEDED',
  }));
  const source = await buildBatchTaskArchive(tasks, async task => ({
    mediaType: 'image/png', originalName: '封面.png', content: Buffer.from([0, 1, 255, task.id]),
  }));
  const rows = await saveSource(root, source, [1, 2]);
  const { members, totalBytes } = await inspectDeliverySources(root, [rows[0]]);
  assert.equal(members.length, 1);
  const original = await JSZip.loadAsync(source);
  const files = Object.values(original.files).filter(file => file.name.startsWith('未归属甲方批次/任务-1-资源包/'));
  let expectedBytes = 0;
  for (const file of files) expectedBytes += (await file.async('nodebuffer')).length;
  assert.equal(totalBytes, expectedBytes);
  const artifacts = await writeDeliveryAggregate(root, job(), members);
  const result = await JSZip.loadAsync(await readFile(join(root, '.delivery-archives', '1', artifacts[0].file)));
  assert.equal(Object.keys(result.files).some(name => name.endsWith('.zip')), false);
  assert.deepEqual(Object.values(result.files).filter(file => !file.dir).map(file => file.name).sort(), files.filter(file => !file.dir).map(file => file.name).sort(),
    'selected files retain the original batch/task paths, with no added files or version directories');
  assert.equal(result.file('清单.xlsx'), null);
  assert.equal(result.file('manifest.json'), null);
  for (const file of files) {
    assert.deepEqual(await result.file(file.name).async('nodebuffer'),
      await file.async('nodebuffer'));
  }
});

test('aggregate flattens legacy task ZIPs and keeps versions separate across batches', async t => {
  const root = await storage(t);
  const rows = [];
  for (const version of [1, 2]) {
    const inner = new JSZip();
    inner.file('文案.txt', `冻结正文${version}`);
    inner.file('01-图片.png', Buffer.from([0, 255, version]));
    const outer = new JSZip();
    outer.file('旧词包/任务-1-资源包.zip', await inner.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    outer.file('旧词包/任务-2-资源包.zip', Buffer.from('unselected member must not be read'));
    const [row] = await saveSource(root, await outer.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    rows.push({ ...row, item_id: version, copy_revision_id: version + 10 });
  }
  const { members, totalBytes } = await inspectDeliverySources(root, rows);
  assert.equal(totalBytes, Buffer.byteLength('冻结正文1冻结正文2') + 6);
  const artifacts = await writeDeliveryAggregate(root, job(), members);
  const result = await JSZip.loadAsync(await readFile(join(root, '.delivery-archives', '1', artifacts[0].file)));
  assert.equal(Object.keys(result.files).some(name => name.endsWith('.zip')), false);
  for (const [index, row] of rows.entries()) {
    const directory=`旧词包/任务-1-资源包${index ? '-2' : ''}`;
    assert.equal(await result.file(`${directory}/文案.txt`).async('string'), `冻结正文${index + 1}`);
    assert.deepEqual(await result.file(`${directory}/01-图片.png`).async('nodebuffer'), Buffer.from([0, 255, index + 1]));
    assert.equal(directory.split('/').length,2,'historical versions must not add directory levels');
  }
});

test('source inspection rejects ambiguous task folders and mixed legacy and new members', async t => {
  const root = await storage(t);
  for (const extraName of ['其他批次/任务-1-资源包/文案.txt', '批次/任务-1-资源包.zip', '批次/任务-1-资源包/COPY.TXT']) {
    const zip = new JSZip();
    zip.file('批次/任务-1-资源包/copy.txt', 'frozen');
    zip.file(extraName, 'duplicate');
    const rows = await saveSource(root, await zip.generateAsync({ type: 'nodebuffer' }));
    await assert.rejects(inspectDeliverySources(root, rows), { code: 'DELIVERY_SOURCE_AMBIGUOUS' });
  }
});

test('source inspection rejects missing tasks, changed source bytes and unsafe legacy file paths', async t => {
  const root = await storage(t);
  const zip = new JSZip();
  zip.file('批次/任务-1-资源包/文案.txt', 'frozen');
  const rows = await saveSource(root, await zip.generateAsync({ type: 'nodebuffer' }), [1, 2]);
  await assert.rejects(inspectDeliverySources(root, rows), { code: 'DELIVERY_SOURCE_MISSING' });
  await assert.rejects(inspectDeliverySources(root, [{ ...rows[0], source_sha256: '0'.repeat(64) }]), { code: 'DELIVERY_SOURCE_MISSING' });
  const inner = new JSZip();
  inner.file('../outside.txt', 'unsafe');
  const legacy = new JSZip();
  legacy.file('批次/任务-1-资源包.zip', await inner.generateAsync({ type: 'nodebuffer' }));
  const unsafeRows = await saveSource(root, await legacy.generateAsync({ type: 'nodebuffer' }));
  await assert.rejects(inspectDeliverySources(root, unsafeRows), /invalid relative path/u);
});

test('aggregate removes partial output when a frozen file disappears after inspection', async t => {
  const root = await storage(t);
  const zip = new JSZip();
  zip.file('批次/任务-1-资源包/文案.txt', 'frozen');
  zip.file('批次/任务-1-资源包/01.png', Buffer.from([1, 2, 3]));
  const rows = await saveSource(root, await zip.generateAsync({ type: 'nodebuffer' }));
  const { members } = await inspectDeliverySources(root, rows);
  zip.remove('批次/任务-1-资源包/01.png');
  await writeFile(members[0].path, await zip.generateAsync({ type: 'nodebuffer' }));
  await assert.rejects(writeDeliveryAggregate(root, job(), members), /冻结成员丢失/u);
  assert.deepEqual(await readdir(join(root, '.delivery-archives', '1')), []);
});

for (const legacy of [false, true]) {
  test(`frozen ${legacy ? 'legacy ZIP' : 'folder'} downloads correct only the original Query and add no files`, async t => {
    const root=await storage(t);
    for (const scenario of [
      {issued:'甲方下发问题\r\n第二行',expected:'甲方下发问题 第二行'},
      {issued:null,expected:'历史 Query'},
      {issued:' \t ',expected:'历史 Query'},
      {expected:'历史 Query'},
    ]) {
      const originalText='\uFEFF原始 Query：生产 Query\r\n\r\n标题：冻结标题\r\n\r\n文案内容：\r\n冻结正文\r\n原始 Query：正文中的文字不要替换\r\n';
      const links='\uFEFFQuery：生产 Query\r\n小红书链接：\r\nhttps://example.test/frozen\r\n';
      const picture=Buffer.from([0,255,13,10,0,1]);
      const originalFiles={'文案.txt':originalText,'小红书链接.txt':links,'01-封面.png':picture};
      const source=new JSZip(),directory='甲方批次/任务-1-资源包';
      if (legacy) {
        const inner=new JSZip();for(const [name,content] of Object.entries(originalFiles))inner.file(name,content);
        source.file(directory+'.zip',await inner.generateAsync({type:'nodebuffer'}));
      } else for(const [name,content] of Object.entries(originalFiles))source.file(directory+'/'+name,content);
      const sourceBytes=await source.generateAsync({type:'nodebuffer'});
      const [row]=await saveSource(root,sourceBytes);
      row.query='历史 Query';row.issued_query=scenario.issued;
      const {members}=await inspectDeliverySources(root,[row]);
      const artifacts=await writeDeliveryAggregate(root,{...job(),kind:legacy?'ARCHIVE':'DOWNLOAD'},members);
      const zip=await JSZip.loadAsync(await readFile(join(root,'.delivery-archives','1',artifacts[0].file)));
      assert.deepEqual(Object.values(zip.files).filter(file=>!file.dir).map(file=>file.name).sort(),
        Object.keys(originalFiles).map(name=>directory+'/'+name).sort());
      const copy=await zip.file(directory+'/文案.txt').async('string');
      assert.equal(copy,'\uFEFF原始 Query：'+scenario.expected+originalText.slice(originalText.indexOf('\r\n')));
      assert.equal(await zip.file(directory+'/小红书链接.txt').async('string'),links);
      assert.deepEqual(await zip.file(directory+'/01-封面.png').async('nodebuffer'),picture);
      assert.deepEqual(await readFile(members[0].path),sourceBytes,'source ZIP must remain unchanged');
    }
  });
}

test('Query header correction handles UTF-8 chunk boundaries, original newlines and large non-copy files',async()=>{
  async function transform(bytes,chunkSize) {
    async function* chunks(){for(let index=0;index<bytes.length;index+=chunkSize)yield bytes.subarray(index,index+chunkSize);}
    const output=[];for await(const chunk of withOriginalDeliveryQuery(chunks(),{issuedQuery:'下发问题',query:'生产问题'}))output.push(chunk);
    return Buffer.concat(output);
  }
  for(const prefix of ['\uFEFF原始 Query：','原始Query:'])for(const newline of ['\r\n','\n','\r','']) {
    const tail=newline ? newline+'冻结正文\u0000\uFEFF保留字节'+newline : '';
    assert.deepEqual(await transform(Buffer.from(prefix+'生产问题'+tail),1),Buffer.from(prefix+'下发问题'+tail));
  }
  const other=Buffer.from('链接说明\n原始 Query：这不是首行\r\n');
  assert.deepEqual(await transform(other,2),other);
  const oversized=Buffer.from('原始 Query：'+'长'.repeat(40_000)+'\n正文');
  assert.deepEqual(await transform(oversized,1024),oversized);
});
