import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {buildProjectRailIdentities} from '../renderer/v2/src/components/project-rail/project-identity.ts';

const segmenter = new Intl.Segmenter('und',{granularity:'grapheme'});
const length = (text) => Array.from(segmenter.segment(text)).length;
const source = (projectId,name) => ({projectId,name});

test('project identities use the first meaningful segment and compact Chinese or Latin monograms',() => {
  const result = buildProjectRailIdentities([
    source('cn','青岚站-demo'),
    source('long-cn','海隅电商生产运维平台'),
    source('en','Production Environment with a long name'),
    source('initial','AI Ops'),
    source('one','a-project'),
  ]);
  assert.deepEqual(result.get('cn'),{monogram:'青',shortName:'青岚站'});
  assert.deepEqual(result.get('long-cn'),{monogram:'海',shortName:'海隅电商'});
  assert.deepEqual(result.get('en'),{monogram:'PR',shortName:'Prod'});
  assert.deepEqual(result.get('initial'),{monogram:'AI',shortName:'AI'});
  assert.deepEqual(result.get('one'),{monogram:'A',shortName:'a'});
});

test('same short prefixes prefer distinguishing name text before falling back to project IDs',() => {
  const result = buildProjectRailIdentities([
    source('production','海隅电商生产'),
    source('staging','海隅电商预发'),
  ]);
  assert.equal(result.get('production').shortName,'海隅生产');
  assert.equal(result.get('staging').shortName,'海隅预发');
  const english = buildProjectRailIdentities([
    source('one','Alpha Production'),source('two','Alpha Preview'),
  ]);
  assert.notEqual(english.get('one').shortName,english.get('two').shortName);
  assert.ok([...english.values()].every(({shortName}) => !/\d/u.test(shortName)));
});

test('identical names receive deterministic ID-derived labels independent of input order',() => {
  const projects = [source('project-c','同名项目'),source('project-a','同名项目'),source('project-b','同名项目')];
  const first = buildProjectRailIdentities(projects);
  assert.deepEqual(first,buildProjectRailIdentities([...projects].reverse()));
  assert.deepEqual(first,buildProjectRailIdentities([projects[1],projects[2],projects[0]]));
  assert.equal(new Set([...first.values()].map(({shortName}) => shortName)).size,3);
  for (const {shortName} of first.values()) assert.match(shortName,/^同名[A-Z0-9]{2}$/u);
});

test('Unicode graphemes survive truncation and emoji-only or punctuation-only names have a meaningful fallback',() => {
  const result = buildProjectRailIdentities([
    source('accent','  🚀 E\u0301cole-longue  '),
    source('astral','𠮷野家環境平台'),
    source('marks','क्‍षेत्र-दो'),
    source('empty','  -- … 👩🏽‍💻 1️⃣ 🏳️‍🌈 '),
  ]);
  assert.deepEqual(result.get('accent'),{monogram:'ÉC',shortName:'Écol'});
  assert.deepEqual(result.get('astral'),{monogram:'𠮷',shortName:'𠮷野家環'});
  assert.ok(result.get('marks').shortName.startsWith('क्‍ष'));
  assert.deepEqual(result.get('empty'),{monogram:'项',shortName:'项目'});
  for (const {monogram,shortName} of result.values()) {
    assert.ok(length(shortName) >= 1 && length(shortName) <= 4);
    assert.ok(length(monogram) >= 1 && length(monogram) <= 2);
  }
});

test('colliding ID short codes and natural labels remain distinct without ordering numbers',() => {
  const projects = Array.from({length:100},(_,index) => source(`project-${index}`,'共享项目'));
  const result = buildProjectRailIdentities(projects);
  assert.equal(new Set([...result.values()].map(({shortName}) => shortName)).size,projects.length);
  assert.deepEqual(result,buildProjectRailIdentities([...projects].reverse()));
  const occupied = result.get('project-0').shortName;
  const withNatural = buildProjectRailIdentities([...projects,source('natural-label',occupied)]);
  assert.equal(withNatural.get('natural-label').shortName,occupied);
  assert.notEqual(withNatural.get('project-0').shortName,occupied);
  for (const {shortName} of withNatural.values()) assert.ok(length(shortName) <= 4);
});

test('identity generation accepts an empty list, does not mutate input, and has no storage dependency',async () => {
  assert.deepEqual(buildProjectRailIdentities([]),new Map());
  const projects = Object.freeze([
    Object.freeze(source('z','海隅电商生产')),
    Object.freeze(source('a','海隅电商预发')),
  ]);
  const before = JSON.stringify(projects);
  assert.deepEqual(buildProjectRailIdentities(projects),buildProjectRailIdentities([...projects].reverse()));
  assert.equal(JSON.stringify(projects),before);
  const code = await fs.readFile('renderer/v2/src/components/project-rail/project-identity.ts','utf8');
  assert.doesNotMatch(code,/\b(?:window|document|localStorage|sessionStorage|fetch)\b/u);
});
