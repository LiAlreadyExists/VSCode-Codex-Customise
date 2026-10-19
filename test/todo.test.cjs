const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findTodos, buildPrompt, usesNativeAction } = require('../dist/todo');

test('matches triggers inside quotes, after unmatched quotes and inside words', () => {
  const source = 'const a = "//TODO: quoted";\nLet $Q\' match a state.\n//TODO: implement sum\nTODOsomething\n';
  const matches = findTodos(source, 'TODO');
  assert.deepEqual(matches.map(x => x.comment), [': quoted";', ': implement sum', 'something']);
  assert.equal(source.slice(matches[0].offset, matches[0].offset + 4), 'TODO');
  assert.equal(findTodos("Let $Q' be a state.\n%codex draw a graph", '%codex').length, 1);
});
test('matches exact literal text anywhere on a line', () => {
  assert.deepEqual(findTodos('prefix FIXME fix\nfixme no\n# FIXME yes', 'FIXME').map(x => x.comment), [' fix', ' yes']);
  assert.deepEqual(findTodos('//TODO: one\n#TODO: two', '//TODO').map(x => x.comment), [': one']);
  assert.equal(findTodos('// TODO: spaced', '//TODO').length, 0);
  assert.equal(findTodos('// TODO: spaced', '// TODO')[0].comment, ': spaced');
  assert.equal(findTodos('// [do.*] fix', '[do.*]')[0].comment, ' fix');
  assert.equal(findTodos('anything %codex rest', '%codex')[0].comment, ' rest');
  assert.equal(findTodos('//TODO', '').length, 0);
  assert.equal(findTodos('//TODO', 'TODO\n').length, 0);
  assert.equal(findTodos('//TODO', 'TO\nDO').length, 0);
});
test('preserves punctuation, whitespace and comment formatting after the trigger', () => {
  assert.equal(findTodos('<!-- TASK: layout -->', 'TASK')[0].comment, ': layout -->');
  assert.equal(findTodos('//TODO- \twin  \r\n', 'TODO')[0].comment, '- \twin  ');
  assert.equal(findTodos('/* TODO * formatting */', 'TODO')[0].comment, ' * formatting */');
  assert.equal(findTodos('"""\n# TODO: string\n"""\n# TODO: real', 'TODO').length, 2);
});
test('expands only known placeholders once and preserves exact custom messages', () => {
  const context = { file: '/fixture/src/a.ts', workspace: '/fixture', line: 7, comment: 'keep {line}' };
  assert.equal(buildPrompt(context, '{relativeFile}:{line} {comment} {unknown}'), 'src/a.ts:7 keep {line} {unknown}');
  assert.equal(buildPrompt(context, 'exact message\n'), 'exact message\n');
  const original = buildPrompt(context, '');
  assert.match(original, /\/fixture\/src\/a.ts:7/);
  assert.match(original, /Once you are done, remove the comment\.$/);
  assert.ok(buildPrompt({ ...context, comment: ' : exact  ' }, '').includes('The comment is:\n : exact  \n\n'));
  assert.equal(buildPrompt({ ...context, file: 'untitled:Untitled-1' }, '{relativeFile}'), 'untitled:Untitled-1');
  assert.equal(usesNativeAction('', ''), true);
  assert.equal(usesNativeAction('custom', ''), false);
  assert.equal(usesNativeAction('', 'saved-1'), false);
});
