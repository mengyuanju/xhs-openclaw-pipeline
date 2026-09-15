import assert from 'node:assert/strict';
import test from 'node:test';

import { startImageEditProcessing } from '../src/image-edit-runner.mjs';

test('image edit queue runner starts immediately, never overlaps, and shutdown waits for active work',async()=>{
  const entered=Promise.withResolvers(),finish=Promise.withResolvers();
  let calls=0,stopped=false;
  const stop=startImageEditProcessing({service:{claim(){}},storageRoot:'test-storage'},{intervalMs:100,
    processEdit:async()=>{calls++;entered.resolve();await finish.promise;return{status:'PREVIEW_READY'};},log:{log(){},error(){}}});
  const keepAlive=setTimeout(()=>{},1000);
  try{
    await entered.promise;
    await new Promise(resolve=>setTimeout(resolve,220));
    assert.equal(calls,1);
    const stopping=stop().then(()=>{stopped=true;});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(stopped,false);
    finish.resolve();await stopping;
    await new Promise(resolve=>setTimeout(resolve,120));
    assert.equal(calls,1);
  }finally{finish.resolve();await stop();clearTimeout(keepAlive);}
});

test('image edit queue runner validates its configuration before starting',()=>{
  assert.throws(()=>startImageEditProcessing({service:null,storageRoot:'x'}),/service/u);
  assert.throws(()=>startImageEditProcessing({service:{claim(){}},storageRoot:''}),/storage/u);
  assert.throws(()=>startImageEditProcessing({service:{claim(){}},storageRoot:'x'},{intervalMs:99}),/interval/u);
});
