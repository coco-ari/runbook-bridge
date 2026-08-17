import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerOperations, serverOperationInternals } from '../src/server-operations.mjs';

const plugin={projectId:'p1',environmentId:'e1',pluginInstanceId:'s1',pluginType:'server',limits:{maxBytes:65536},actions:[{actionId:'service.status',serviceId:'orders',displayName:'Orders',unit:'orders.service'},{actionId:'filesystem.usage',mountId:'data',displayName:'Data',mountPath:'/srv/data'}],sources:[]};

test('Server operations map actionId to fixed commands and reject arbitrary parameters', () => {
  const operations=new ServerOperations({},{});
  assert.equal(operations.commandFor(plugin,'service.status',{serviceId:'orders'}),'LC_ALL=C systemctl --no-pager --full status -- orders.service');
  assert.equal(operations.commandFor(plugin,'filesystem.usage',{mountId:'data'}),'LC_ALL=C df -P -B1 -- /srv/data');
  assert.throws(()=>operations.commandFor(plugin,'service.status',{serviceId:'orders',command:'rm -rf /'}),(error)=>error.code==='INVALID_ARGUMENT');
  assert.throws(()=>operations.commandFor(plugin,'bash',{}),(error)=>error.code==='POLICY_DENIED');
});

test('configuration reader redacts common secret formats', () => {
  const value=serverOperationInternals.redactConfig('username=app\npassword=hunter2\nAuthorization: Bearer abc.def\nnormal=value');
  const json=serverOperationInternals.redactConfig('{"username":"app","password":"json-secret","nested":{"token":"nested-secret"}}');
  const structured=serverOperationInternals.redactConfig('secret: |\n  line-one\n  line-two\nname: safe\n<password>xml-secret</password>');
  assert.doesNotMatch(value,/hunter2|abc\.def/);
  assert.doesNotMatch(json,/json-secret|nested-secret/);
  assert.doesNotMatch(structured,/line-one|line-two|xml-secret/);
  assert.match(value,/normal=value/);
});

test('log tools reject configuration handles while config reads return sensitive content unchanged', async () => {
  const content='username=app\npassword=supersecret\nnormal=value';
  const runtime={readRemoteRange:async()=>({content,startByte:0,endByte:Buffer.byteLength(content),size:Buffer.byteLength(content),truncated:false,mtime:7})};
  const operations=new ServerOperations(runtime,{});
  const configSource={sourceId:'config',displayName:'Config',kind:'config',root:'/etc/app',patterns:['*.conf'],maxFileBytes:1024};
  const scopedPlugin={...plugin,sources:[configSource]};
  const fileId=operations.rememberFile(scopedPlugin,configSource,{canonicalPath:'/etc/app/app.conf',size:Buffer.byteLength(content),mtime:7});
  await assert.rejects(()=>operations.readLog(scopedPlugin,{fileId}),(error)=>error.code==='SOURCE_NOT_ALLOWED');
  await assert.rejects(()=>operations.searchLogs(scopedPlugin,{fileIds:[fileId],contains:'secret'}),(error)=>error.code==='SOURCE_NOT_ALLOWED');
  let cursor=null;
  let combined='';
  do {
    const page=await operations.readConfig(scopedPlugin,{fileId,cursor,maxBytes:5});
    combined+=page.content;
    cursor=page.nextCursor;
  } while(cursor);
  assert.match(combined,/supersecret/);
  assert.doesNotMatch(combined,/\[REDACTED\]/);
});

test('recursive file discovery reuses one remote read session', async () => {
  let sessions=0;
  let activeListings=0;
  let maxActiveListings=0;
  const listed=[];
  const directories={
    '/logs':[
      {name:'api',canonicalPath:'/logs/api',isDirectory:true,isFile:false,isSymbolicLink:false},
      {name:'manage',canonicalPath:'/logs/manage',isDirectory:true,isFile:false,isSymbolicLink:false},
      {name:'root.log',canonicalPath:'/logs/root.log',isDirectory:false,isFile:true,isSymbolicLink:false,size:10,mtime:3},
    ],
    '/logs/api':[
      {name:'today.log',canonicalPath:'/logs/api/today.log',isDirectory:false,isFile:true,isSymbolicLink:false,size:20,mtime:4},
    ],
    '/logs/manage':[],
  };
  const runtime={
    withRemoteReadSession:async(_plugin,operation)=>{
      sessions+=1;
      return operation({
        listDirectory:async(remotePath)=>{
          listed.push(remotePath);
          activeListings+=1;
          maxActiveListings=Math.max(maxActiveListings,activeListings);
          await new Promise((resolve)=>setTimeout(resolve,2));
          activeListings-=1;
          return directories[remotePath] ?? [];
        },
        readRange:async()=>{throw new Error('unexpected read');},
      });
    },
  };
  const operations=new ServerOperations(runtime,{});
  const result=await operations.findFiles(plugin,{path:'/logs',pattern:'*.log',maxDepth:2,maxResults:10});
  assert.equal(sessions,1);
  assert.equal(maxActiveListings,2);
  assert.deepEqual(listed,['/logs','/logs/api','/logs/manage']);
  assert.deepEqual(result.files.map((file)=>file.path),['/logs/root.log','/logs/api/today.log']);
});

test('file search shares one remote read session across discovery and reads', async () => {
  let sessions=0;
  let reads=0;
  const runtime={
    withRemoteReadSession:async(_plugin,operation)=>{
      sessions+=1;
      return operation({
        listDirectory:async()=>[
          {name:'app.log',canonicalPath:'/logs/app.log',isDirectory:false,isFile:true,isSymbolicLink:false,size:25,mtime:5},
        ],
        readRange:async(remotePath,start)=>{
          reads+=1;
          assert.equal(remotePath,'/logs/app.log');
          assert.equal(start,0);
          return {canonicalPath:remotePath,content:'INFO boot\nERROR failed\n',startByte:0,endByte:23,size:23,truncated:false,mtime:5};
        },
      });
    },
  };
  const operations=new ServerOperations(runtime,{});
  const result=await operations.searchFiles(plugin,{path:'/logs',pattern:'*.log',contains:'ERROR',maxDepth:1,maxFiles:5,maxMatches:5,maxScanBytes:65536});
  assert.equal(sessions,1);
  assert.equal(reads,1);
  assert.equal(result.matchCount,1);
  assert.equal(result.matches[0].text,'ERROR failed');
});
