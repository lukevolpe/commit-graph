import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filePathspecs, isEmptyQuery, parseDate, parseQuery } from '../src/search';
import { search } from '../src/git';

const NOW = new Date(2026, 5, 15, 12).getTime();
const local = (y: number, m: number, d: number) => Math.floor(new Date(y, m - 1, d).getTime() / 1000);

test('parseQuery splits plain words and operators', () => {
  const q = parseQuery('Fix "login bug" author:"Ada L" message:Crash #ABC123 sha:def file:src/*.ts type:merge', NOW);
  assert.deepEqual(q.text, ['fix', 'login bug']);
  assert.deepEqual(q.author, ['ada l']);
  assert.deepEqual(q.message, ['crash']);
  assert.deepEqual(q.sha, ['abc123', 'def']);
  assert.deepEqual(q.files, ['src/*.ts']);
  assert.equal(q.merge, true);
  assert.equal(parseQuery('type:nonmerge').merge, false);
});

test('parseQuery dates: ISO, relative, tightest bound wins', () => {
  const q = parseQuery('after:2026-01-01 after:2026-02-01 before:2026-06-01', NOW);
  assert.equal(q.after, local(2026, 2, 1));
  assert.equal(q.before, local(2026, 6, 1));
  assert.equal(parseQuery('after:2w', NOW).after, Math.floor(NOW / 1000) - 14 * 86400);
  assert.equal(parseDate('2026-02-30'), undefined);
  assert.equal(parseDate('2026-03'), local(2026, 3, 1));
});

test('parseQuery never throws: unknown or bad operators become plain text', () => {
  assert.deepEqual(parseQuery('foo:bar').text, ['foo:bar']);
  assert.deepEqual(parseQuery('after:someday').text, ['after:someday']);
  assert.deepEqual(parseQuery('type:weird').text, ['type:weird']);
  assert.deepEqual(parseQuery('sha:xyz').text, ['sha:xyz']);
  assert.deepEqual(parseQuery('http://x.y').text, ['http://x.y']);
  // Half-typed: ignored, not searched for literally.
  assert.ok(isEmptyQuery(parseQuery('author: ')));
  assert.ok(isEmptyQuery(parseQuery('author:"')));
  assert.ok(isEmptyQuery(parseQuery('   ')));
  for (const s of ['"', ':', 'a:"b', '#', '::::', 'after:', 'file:""']) assert.doesNotThrow(() => parseQuery(s));
});

test('filePathspecs: bare names match anywhere, slash or leading / anchors', () => {
  assert.deepEqual(filePathspecs('*.css'), [':(top,glob,icase)**/*.css', ':(top,glob,icase)**/*.css/**']);
  assert.deepEqual(filePathspecs('src/git.ts'), [':(top,glob,icase)src/git.ts', ':(top,glob,icase)src/git.ts/**']);
  assert.equal(filePathspecs('/readme.md')[0], ':(top,glob,icase)readme.md');
  assert.deepEqual(filePathspecs('/'), []);
});

test('search ANDs operators over the index', () => {
  const d = local(2026, 3, 10);
  const index = [
    { hash: 'aaaa1111', author: 'ada lovelace ada@x', text: 'ada lovelace ada@x fix login bug', date: d, parents: 1 },
    { hash: 'bbbb2222', author: 'bob b@x', text: 'bob b@x merge branch ada', date: d + 86400 * 60, parents: 2 },
    { hash: 'cccc3333', author: 'carol c@x', text: 'carol c@x fix crash', date: d - 86400 * 60, parents: 1 },
  ];
  assert.deepEqual(search(index, 'ada'), ['aaaa1111', 'bbbb2222']);
  assert.deepEqual(search(index, 'author:ada'), ['aaaa1111']);
  assert.deepEqual(search(index, 'message:ada'), ['bbbb2222']);
  assert.deepEqual(search(index, 'fix after:2026-03-01'), ['aaaa1111']);
  assert.deepEqual(search(index, 'before:2026-03-01'), ['cccc3333']);
  assert.deepEqual(search(index, 'type:merge'), ['bbbb2222']);
  assert.deepEqual(search(index, 'type:nonmerge fix'), ['aaaa1111', 'cccc3333']);
  assert.deepEqual(search(index, '#BBBB'), ['bbbb2222']);
  assert.deepEqual(search(index, 'fix #bbbb'), []);
  assert.deepEqual(search(index, 'author:'), []);
  // file: terms filter by the set the caller resolved with git.
  assert.deepEqual(search(index, 'file:x fix', new Set(['cccc3333'])), ['cccc3333']);
});
