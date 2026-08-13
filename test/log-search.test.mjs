import assert from 'node:assert/strict';
import test from 'node:test';
import { LogSearchCursorStore, searchLogSnapshots } from '../src/log-search.mjs';

test('search uses literal case-insensitive OR matching and does not interpret regex syntax', () => {
  const result = searchLogSnapshots({
    snapshots: [{
      path: '/logs/app.log',
      content: 'ready\nERROR request [abc].*\nerror without literal\n[abc].* only',
    }],
    keywords: ['ERROR', '[abc].*'],
    keywordMode: 'OR',
  });

  assert.equal(result.totalMatches, 3);
  assert.deepEqual(result.matches.map((match) => match.lineNumber), [2, 3, 4]);
  assert.deepEqual(result.matches[0].matchedKeywords, ['ERROR', '[abc].*']);
  assert.deepEqual(result.matches[1].matchedKeywords, ['ERROR']);
  assert.deepEqual(result.matches[2].matchedKeywords, ['[abc].*']);
});

test('AND matching requires all literals on one line and supports case-sensitive searches', () => {
  const insensitive = searchLogSnapshots({
    snapshots: [{ path: 'app.log', content: 'Order 42 failed\norder 42 FAILED\nOrder only' }],
    keywords: ['Order', 'FAILED'],
    keywordMode: 'and',
    caseSensitive: false,
  });
  assert.deepEqual(insensitive.matches.map((match) => match.lineNumber), [1, 2]);

  const sensitive = searchLogSnapshots({
    snapshots: [{ path: 'app.log', content: 'Order 42 failed\norder 42 FAILED\nOrder only' }],
    keywords: ['Order', 'FAILED'],
    keywordMode: 'AND',
    caseSensitive: true,
  });
  assert.equal(sensitive.totalMatches, 0);
});

test('overlapping and adjacent context ranges are merged without losing line metadata', () => {
  const result = searchLogSnapshots({
    snapshots: [{
      path: 'service.log',
      content: ['zero', 'hit one', 'between', 'hit two', 'tail', 'far', 'hit three'].join('\r\n'),
    }],
    keywords: ['hit'],
    beforeLines: 1,
    afterLines: 1,
  });

  assert.equal(result.contexts.length, 1);
  assert.deepEqual(
    result.contexts.map(({ startLine, endLine }) => ({ startLine, endLine })),
    [{ startLine: 1, endLine: 7 }],
  );
  assert.deepEqual(result.contexts[0].matchLineNumbers, [2, 4, 7]);
  assert.deepEqual(result.contexts[0].selectedMatchLineNumbers, [2, 4, 7]);
  assert.equal(result.contexts[0].lines[1].isMatch, true);
  assert.equal(result.contexts[0].lines[2].isMatch, false);
});

test('result limiting still reports complete totals, first/last matches, and truncation sources', () => {
  const result = searchLogSnapshots({
    snapshots: [
      {
        path: 'old.log',
        content: 'INFO\nERROR first\nERROR second',
        sizeBytes: 1_000,
        scannedBytes: 30,
        truncated: true,
      },
      {
        path: 'new.log',
        content: 'ERROR third\nOK\nERROR last',
        sizeBytes: 25,
        scannedBytes: 25,
        truncated: false,
      },
    ],
    keywords: ['ERROR'],
    maxMatches: 2,
  });

  assert.equal(result.totalMatches, 4);
  assert.equal(result.returnedMatches, 2);
  assert.equal(result.firstMatch.path, 'old.log');
  assert.equal(result.firstMatch.lineNumber, 2);
  assert.equal(result.lastMatch.path, 'new.log');
  assert.equal(result.lastMatch.lineNumber, 3);
  assert.equal(result.truncated, true);
  assert.deepEqual(
    {
      sourceTruncated: result.truncation.sourceTruncated,
      resultLimited: result.truncation.resultLimited,
      omittedMatches: result.truncation.omittedMatches,
    },
    { sourceTruncated: true, resultLimited: true, omittedMatches: 2 },
  );
  assert.equal(result.truncation.snapshots[0].unscannedBytes, 970);
  assert.equal(result.snapshots[0].totalMatches, 2);
  assert.equal(result.snapshots[1].returnedMatches, 0);
});

test('match descriptors cap a single huge line by UTF-8 bytes', () => {
  const hugeLine = `ERROR ${'界'.repeat(400_000)}`;
  const result = searchLogSnapshots({
    snapshots: [{ path: 'huge.log', content: hugeLine }],
    keywords: ['ERROR'],
  });
  assert.equal(result.firstMatch.textTruncated, true);
  assert.equal(result.firstMatch.originalTextBytes, Buffer.byteLength(hugeLine));
  assert.ok(Buffer.byteLength(result.firstMatch.text, 'utf8') <= 8 * 1024 + 2);
  assert.equal(result.snapshots[0].firstMatch.textTruncated, true);
});

test('search validates inputs and permits a metadata-only zero match limit', () => {
  assert.throws(
    () => searchLogSnapshots({ snapshots: [], keywords: ['x'], keywordMode: 'XOR' }),
    (error) => error.code === 'INVALID_LOG_SEARCH_ARGUMENT',
  );
  assert.throws(
    () => searchLogSnapshots({ snapshots: [], keywords: [''] }),
    (error) => error.code === 'INVALID_LOG_SEARCH_ARGUMENT',
  );

  const result = searchLogSnapshots({
    snapshots: [{ path: 'a.log', content: 'x\nx' }],
    keywords: ['x'],
    maxMatches: 0,
  });
  assert.equal(result.totalMatches, 2);
  assert.equal(result.returnedMatches, 0);
  assert.equal(result.contexts.length, 0);
  assert.equal(result.truncation.resultLimited, true);
});

test('cursor pages are opaque, capped at 100, stateful, and removed after completion', () => {
  const store = new LogSearchCursorStore({ ttlMs: 10_000 });
  const items = Array.from({ length: 205 }, (_, index) => ({ lineNumber: index + 1 }));
  const cursor = store.create({
    projectId: 'private-project',
    token: 'private-token',
    items,
    metadata: { totalMatches: 205 },
  });

  assert.equal(typeof cursor, 'string');
  assert.ok(cursor.length >= 32);
  assert.equal(cursor.includes('private-project'), false);
  assert.equal(cursor.includes('private-token'), false);

  const first = store.page({
    cursor,
    projectId: 'private-project',
    token: 'private-token',
    pageSize: 1_000,
  });
  assert.equal(first.items.length, 100);
  assert.equal(first.nextCursor, cursor);
  assert.equal(first.metadata.totalMatches, 205);

  const second = store.read({
    cursor,
    projectId: 'private-project',
    token: 'private-token',
  });
  assert.equal(second.items.length, 100);
  assert.equal(second.offset, 100);

  const last = store.page({ cursor, projectId: 'private-project', token: 'private-token' });
  assert.equal(last.items.length, 5);
  assert.equal(last.hasMore, false);
  assert.equal(last.nextCursor, null);
  assert.deepEqual(store.stats().cursors, 0);
  assert.throws(
    () => store.page({ cursor, projectId: 'private-project', token: 'private-token' }),
    (error) => error.code === 'INVALID_LOG_SEARCH_CURSOR',
  );
});

test('cursor access is bound to both project and token without consuming the cursor on failure', () => {
  const store = new LogSearchCursorStore();
  const cursor = store.create({ projectId: 'one', token: 'secret', items: ['body'] });

  assert.throws(
    () => store.page({ cursor, projectId: 'two', token: 'secret' }),
    (error) => error.code === 'INVALID_LOG_SEARCH_CURSOR',
  );
  assert.throws(
    () => store.page({ cursor, projectId: 'one', token: 'wrong' }),
    (error) => error.code === 'INVALID_LOG_SEARCH_CURSOR',
  );
  assert.deepEqual(
    store.page({ cursor, projectId: 'one', token: 'secret' }).items,
    ['body'],
  );
});

test('cursor TTL expiry and explicit project cleanup release cached data', () => {
  let now = 1_000;
  const store = new LogSearchCursorStore({ ttlMs: 50, now: () => now });
  const expired = store.create({ projectId: 'one', token: 'secret', items: ['sensitive body'] });
  store.create({ projectId: 'two', token: 'secret', items: ['other body'] });
  assert.equal(store.stats().cursors, 2);

  now = 1_051;
  assert.throws(
    () => store.page({ cursor: expired, projectId: 'one', token: 'secret' }),
    (error) => error.code === 'INVALID_LOG_SEARCH_CURSOR',
  );
  assert.equal(store.stats().cursors, 0);

  now = 2_000;
  store.create({ projectId: 'one', token: 'secret', items: ['a'] });
  store.create({ projectId: 'one', token: 'secret', items: ['b'] });
  store.create({ projectId: 'two', token: 'secret', items: ['c'] });
  assert.equal(store.clearProject('one'), 2);
  assert.equal(store.stats().cursors, 1);
  assert.equal(JSON.stringify(store.stats()).includes('sensitive body'), false);
});

test('cache entry and byte limits reject oversized results and evict oldest cursors', () => {
  const entries = new LogSearchCursorStore({ maxEntries: 3, maxBytes: 10_000, maxCursors: 5 });
  const oldest = entries.create({ projectId: 'one', token: 'secret', items: [1, 2] });
  const newest = entries.create({ projectId: 'one', token: 'secret', items: [3, 4] });
  assert.equal(entries.stats().cachedEntries, 2);
  assert.throws(
    () => entries.page({ cursor: oldest, projectId: 'one', token: 'secret' }),
    (error) => error.code === 'INVALID_LOG_SEARCH_CURSOR',
  );
  assert.deepEqual(
    entries.page({ cursor: newest, projectId: 'one', token: 'secret' }).items,
    [3, 4],
  );

  const bytes = new LogSearchCursorStore({ maxEntries: 10, maxBytes: 20 });
  assert.throws(
    () => bytes.create({ projectId: 'one', token: 'secret', items: ['x'.repeat(100)] }),
    (error) => error.code === 'LOG_SEARCH_CACHE_LIMIT',
  );
  assert.deepEqual(bytes.stats(), {
    cursors: 0,
    cachedEntries: 0,
    cachedBytes: 0,
    maxCursors: 100,
    maxCachedEntries: 10,
    maxCachedBytes: 20,
    maxPageSize: 100,
    ttlMs: 300_000,
  });
});
