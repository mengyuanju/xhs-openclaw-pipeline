import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('profile name browser: required input, native eighty-character limit, failed save retention and persisted retry', {
  skip: process.env.RUN_PROFILE_NAME_BROWSER !== '1', timeout: 60_000,
}, async () => {
  const { build } = await import('esbuild'), { chromium } = await import('playwright-core');
  const root=resolve('.codex_artifacts/profile-name');await mkdir(root,{recursive:true});const directory=await mkdtemp(join(root,'browser-'));
  await build({stdin:{contents:`import React from'react';import{createRoot}from'react-dom/client';import{ProfileManager}from'./app/profile/profile-manager';fetch('/fixture-profile').then(r=>r.json()).then(user=>createRoot(document.getElementById('root')).render(<ProfileManager user={user}/>));`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,outfile:join(directory,'bundle.js'),platform:'browser',jsx:'automatic',alias:{'@':process.cwd()},define:{'process.env.NODE_ENV':'"test"'},plugins:[{name:'fixture-router',setup(plugin){plugin.onResolve({filter:/^next\/navigation$/},args=>({path:args.path,namespace:'fixture-router'}));plugin.onLoad({filter:/.*/,namespace:'fixture-router'},()=>({contents:'const router={refresh(){location.reload()},replace(){}};export const useRouter=()=>router;'}));}}]});
  const js=await readFile(join(directory,'bundle.js'));let profile={username:'synthetic-profile',displayName:'合成测试姓名',role:'USER',status:'ACTIVE',mustChangePassword:false,version:1},fails=true,browser;
  const requests=[],errors=[];
  const server=createServer(async(request,response)=>{
    if(request.url==='/bundle.js'){response.setHeader('content-type','application/javascript');response.end(js);return;}
    if(request.url==='/fixture-profile'){response.setHeader('content-type','application/json');response.end(JSON.stringify(profile));return;}
    if(request.url==='/api/control-plane/v1/profile'&&request.method==='PATCH'){
      let raw='';for await(const chunk of request)raw+=chunk;const body=JSON.parse(raw);requests.push(body);assert.equal(body.expectedVersion,profile.version);assert.equal(body.displayName.length,80);
      response.setHeader('content-type','application/json');if(fails){response.statusCode=503;response.end(JSON.stringify({error:{code:'FIXTURE',message:'合成姓名保存暂时失败'}}));return;}
      profile={...profile,displayName:body.displayName,version:profile.version+1};response.end(JSON.stringify({data:profile}));return;
    }
    response.setHeader('content-type','text/html; charset=utf-8');response.end('<html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script></html>');
  });await new Promise(done=>server.listen(0,'127.0.0.1',done));
  try{
    browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'chromium-headless-shell'});const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
    const field=page.getByLabel('显示姓名',{exact:true}),save=page.getByRole('button',{name:'保存资料',exact:true});await field.waitFor();
    await field.fill('');assert.equal(await field.evaluate(e=>e.checkValidity()),false);await save.click();assert.equal(requests.length,0);
    await field.pressSequentially('界'.repeat(81));assert.equal((await field.inputValue()).length,80);assert.equal(await field.evaluate(e=>e.checkValidity()),true);
    await save.click();await page.getByRole('alert').filter({hasText:'合成姓名保存暂时失败'}).waitFor();assert.equal(await field.inputValue(),'界'.repeat(80));assert.equal(profile.displayName,'合成测试姓名');
    fails=false;await save.click();await page.waitForFunction(()=>document.querySelector('#profile-name')?.value==='界'.repeat(80)&&document.querySelector('.profile-identity h2')?.textContent==='界'.repeat(80));
    assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);assert.equal(profile.version,2);assert.deepEqual(errors,[]);
    await writeFile(join(directory,'evidence.json'),JSON.stringify({featureIds:['F-AUTH-011'],modelCalls:0,syntheticProfile:true,requests,errors},null,2));
  }finally{await browser?.close();server.closeAllConnections();await new Promise(done=>server.close(done));}
});
