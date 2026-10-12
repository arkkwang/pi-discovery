import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { executionTrajectory, recommendationQuery } from '../trajectory.js';
import { snapPath, snapCliMissing, sessionFixture } from './snap-fixture.mjs';
const message = (role, content, extra={}) => ({type:'message',message:{role,content,...extra}});

test('executes source pi-snap via PATH; arguments are literal; no local semantic renderer', { skip: snapCliMissing }, async t => {
 await snapPath(t.after.bind(t));
 const sm=await sessionFixture(t.after.bind(t),[
  message('user','Task'),message('assistant',[{type:'thinking',thinking:'THINK_SECRET'},{type:'text',text:'Checking'},
   {type:'toolCall',id:'call',name:'bash',arguments:{command:'git status'}}]),
  message('toolResult',[{type:'text',text:'OUTPUT_SECRET'}],{toolCallId:'call',toolName:'bash',isError:true}),
  {type:'compaction',summary:'SUMMARY_SECRET'},
  {type:'context_edit',targetId:'e2',replacement:null},
 ]);
 const text=await executionTrajectory(sm);
 // pi-snap ≥0.3.3 keeps context edits out of the default trajectory (host bookkeeping,
 // visible via --trace/entry details); success result bodies are omitted there as well.
 for(const value of ['Task','Checking','git status','ERR','compact']) assert.ok(text.includes(value),text);
 assert.doesNotMatch(text,/SECRET/);
 const query=await recommendationQuery('CURRENT',sm,[{data:'IMAGE_SECRET'}]);
 assert.match(query,/CURRENT/);assert.match(query,/\[image\]/);assert.doesNotMatch(query,/IMAGE_SECRET/);
});

test('outer budget crops plain output to recent 6000, current request remains separate', { skip: snapCliMissing }, async t => {
 await snapPath(t.after.bind(t));
 const sm=await sessionFixture(t.after.bind(t),[message('user','OLDER'),message('assistant','RECENT_HEAD'+'x'.repeat(20000)+'RECENT_TAIL')]);
 const trajectory=await executionTrajectory(sm);
 assert.ok(trajectory.length<=6000);assert.match(trajectory,/truncated/);assert.match(trajectory,/RECENT_TAIL/);assert.doesNotMatch(trajectory,/OLDER|RECENT_HEAD/);
 const query=await recommendationQuery('CURRENT HEAD'+'z'.repeat(20000)+'CURRENT TAIL',sm);
 assert.ok(query.length<10100);assert.match(query,/CURRENT HEAD/);assert.match(query,/CURRENT TAIL/);
});

test('first input without historical messages does not invoke CLI; missing persisted history fails explicitly', async t => {
 await snapPath(t.after.bind(t),'#!/usr/bin/env bash\necho should-not-run >&2\nexit 92\n');
 const empty=await executionTrajectory({getBranch:()=>[{type:'custom',customType:'capability-prefetch-diagnostic'}],getSessionFile:()=>'/not-created.jsonl'});
 assert.match(empty,/No prior conversation/);
 await assert.rejects(executionTrajectory({getBranch:()=>[message('user','history')]}),/no persisted session file/);
 const sm=await sessionFixture(t.after.bind(t),[message('user','history')]);
 await assert.rejects(executionTrajectory(sm),/should-not-run/);
});

test('file errors, CLI failure and cancellation are not silently empty history', { skip: snapCliMissing }, async t => {
 await snapPath(t.after.bind(t));
 const sm=await sessionFixture(t.after.bind(t),[message('user','history')]);
 await rm(sm.getSessionFile());
 await assert.rejects(executionTrajectory(sm),/pi-snap failed/);
 await assert.rejects(executionTrajectory(sm,undefined,{signal:AbortSignal.abort()}),/abort/i);
});

test('in-flight CLI is cancellable and bounded by five seconds', async t => {
 await snapPath(t.after.bind(t),'#!/usr/bin/env bash\nexec sleep 30\n');
 const sm=await sessionFixture(t.after.bind(t),[message('user','history')]);
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),100);t.after(()=>clearTimeout(timer));
 const start=performance.now();await assert.rejects(executionTrajectory(sm,undefined,{signal:controller.signal}),/abort/i);
 assert.ok(performance.now()-start<2000);
 const timeoutStart=performance.now();await assert.rejects(executionTrajectory(sm),/pi-snap timed out/);
 assert.ok(performance.now()-timeoutStart<7000);
});

const sdkRoot=process.env.PI_DISCOVERY_SDK_ROOT;
test('real SDK sync append persists records; boundary diagnostic selects a rewound branch', {skip:!sdkRoot || snapCliMissing},async t=>{
 await snapPath(t.after.bind(t));
 const {SessionManager}=await import(pathToFileURL(path.join(sdkRoot,'dist/core/session-manager.js')).href);
 const dir=await mkdtemp(path.join(tmpdir(),'pi-snap-sdk-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const sm=SessionManager.create(dir,dir);
 assert.match(await executionTrajectory(sm),/No prior conversation/);
 const user=sm.appendMessage({role:'user',content:'KEEP_BRANCH',timestamp:Date.now()});
 assert.match(await readFile(sm.getSessionFile(),'utf8'),/KEEP_BRANCH/);
 sm.appendMessage({role:'assistant',content:[{type:'text',text:'DISCARDED_BRANCH'}],timestamp:Date.now()});
 assert.match(await readFile(sm.getSessionFile(),'utf8'),/DISCARDED_BRANCH/);
 sm.branch(user);
 // Branch-only changes the memory cursor. The real boundary's existing diagnostic
 // is the synchronous append that makes the file's last record select this branch.
 sm.appendCustomEntry('capability-prefetch-diagnostic',{event:'start'});
 const rows=(await readFile(sm.getSessionFile(),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(rows.at(-1).id,sm.getLeafId());
 const trajectory=await executionTrajectory(sm);
 assert.match(trajectory,/KEEP_BRANCH/);assert.doesNotMatch(trajectory,/DISCARDED_BRANCH/);
});
