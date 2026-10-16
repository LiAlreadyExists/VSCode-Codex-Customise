const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findTodos, buildPrompt, usesNativeAction } = require('../dist/todo');

test('detects comment TODOs and excludes ordinary strings and word prefixes', () => {
  const source = 'const a = "//TODO: not code";\n//TODO: implement sum\n# TODO other\n-- TODO sql\n/*\n * TODO block\n * continuation\n */\n// TODOsomething\n';
  const matches = findTodos(source, 'TODO');
  assert.deepEqual(matches.map(x => x.comment), ['implement sum', 'other', 'sql', 'block\ncontinuation']);
  assert.equal(source.slice(matches[0].offset, matches[0].offset + 2), '//');
});
test('custom markers are literal and explicit comment prefixes are supported', () => {
  assert.deepEqual(findTodos('//FIXME fix\n//TODO no\n# FIXME yes', 'FIXME').map(x => x.comment), ['fix', 'yes']);
  assert.deepEqual(findTodos('//TODO: one\n#TODO: two', '//TODO').map(x => x.comment), ['one']);
  assert.equal(findTodos('// TODO: spaced', '// TODO')[0].comment, 'spaced');
  assert.equal(findTodos('// [do.*] fix', '[do.*]')[0].comment, 'fix');
  assert.equal(findTodos('//TODO', '').length, 0);
  assert.equal(findTodos('//TODO', 'TODO\n').length, 1);
  assert.equal(findTodos('//TODO', 'TO\nDO').length, 0);
});
test('supports block/HTML comments, CRLF, Python strings and TeX/Matlab comments', () => {
  assert.equal(findTodos('<!-- TASK: layout -->', 'TASK')[0].comment, 'layout');
  assert.equal(findTodos('//TODO: win\r\n', 'todo')[0].comment, 'win');
  assert.equal(findTodos('"""\n# TODO: string\n"""\n# TODO: real', 'TODO', 'python').length, 1);
  assert.equal(findTodos('%TODO: equation', '%TODO', 'latex')[0].comment, 'equation');
  assert.equal(findTodos('x % TODO', 'TODO', 'javascript').length, 0);
});
test('expands only known placeholders once and preserves exact custom messages', () => {
  const context = { file: '/fixture/src/a.ts', workspace: '/fixture', line: 7, comment: 'keep {line}' };
  assert.equal(buildPrompt(context, '{relativeFile}:{line} {comment} {unknown}'), 'src/a.ts:7 keep {line} {unknown}');
  assert.equal(buildPrompt(context, 'exact message\n'), 'exact message\n');
  const original = buildPrompt(context, '');
  assert.match(original, /\/fixture\/src\/a.ts:7/);
  assert.match(original, /Once you are done, remove the comment\.$/);
  assert.equal(usesNativeAction('', ''), true);
  assert.equal(usesNativeAction('custom', ''), false);
  assert.equal(usesNativeAction('', 'saved-1'), false);
});
