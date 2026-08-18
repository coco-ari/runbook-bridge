import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const rendererPath = path.join(testDirectory,'..','renderer','v2','app.js');

test('late connection-check progress cannot replace a completed diagnostic', async () => {
  const renderer = await fs.readFile(rendererPath,'utf8');
  const source = renderer.match(/function mergeDiagnosticProgress[\s\S]*?(?=\nfunction completedDiagnostic)/)?.[0];
  assert.ok(source,'mergeDiagnosticProgress must remain available for the renderer');

  const diagnostic = {
    requestId:7,
    status:'success',
    summary:'全部检查已完成。',
    totalElapsedMs:3,
    checks:[
      {id:'configuration',status:'success'},
      {id:'connection',status:'success'},
      {id:'protocol',status:'success'},
    ],
  };
  const context = vm.createContext({
    diagnostic,
    diagnosticChecks:() => { throw new Error('terminal diagnostics must ignore late progress'); },
    check:{id:'protocol',status:'success',elapsedMs:1},
    result:null,
  });
  vm.runInContext(`${source}\nresult = mergeDiagnosticProgress(diagnostic, {}, check);`,context);

  assert.equal(context.result,diagnostic);
  assert.equal(context.result.status,'success');
  assert.equal(context.result.totalElapsedMs,3);
});
