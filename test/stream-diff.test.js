// SPDX-License-Identifier: MIT
'use strict';

const assert = require('assert');
const { diff } = require('../src/stream-diff');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('empty to non-empty: only inserts', () => {
  assert.deepStrictEqual(diff('', 'hello'), { backspaces: 0, insert: 'hello' });
});

test('non-empty to empty: only backspaces', () => {
  assert.deepStrictEqual(diff('hello', ''), { backspaces: 5, insert: '' });
});

test('append: zero backspaces, partial insert', () => {
  assert.deepStrictEqual(diff('hel', 'hello'), { backspaces: 0, insert: 'lo' });
});

test('divergence: backspace the tail and insert new tail', () => {
  // longest common prefix is "hello wor" (9), so backspace "d" (1) and insert "ld".
  assert.deepStrictEqual(diff('hello word', 'hello world'), { backspaces: 1, insert: 'ld' });
});

test('total replacement: backspace all, insert new', () => {
  assert.deepStrictEqual(diff('abc', 'xyz'), { backspaces: 3, insert: 'xyz' });
});

test('identical: no-op', () => {
  assert.deepStrictEqual(diff('same', 'same'), { backspaces: 0, insert: '' });
});

test('shorter suffix of same prefix: backspace only', () => {
  assert.deepStrictEqual(diff('hello world', 'hello'), { backspaces: 6, insert: '' });
});

test('partial refinement mid-sentence', () => {
  // "Hello, Wurld" refined to "Hello, World"
  assert.deepStrictEqual(diff('Hello, Wurld', 'Hello, World'), { backspaces: 4, insert: 'orld' });
});

test('whitespace changes are real diffs', () => {
  assert.deepStrictEqual(diff('ab', 'a b'), { backspaces: 1, insert: ' b' });
});

(async () => {
  let passed = 0, failed = 0;
  console.log('stream-diff');
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ok   ${name}`);
      passed++;
    } catch (e) {
      console.log(`  FAIL ${name}\n       ${e.message}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
