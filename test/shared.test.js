import test from 'node:test'
import assert from 'node:assert/strict'

import { isDocumentPath, isPathInside, parseDecisionInput, toPosixPath } from '../src/shared.js'

test('/decision with no argument opens the picker', () => {
  assert.deepEqual(parseDecisionInput(''), { mode: 'pick', arg: '' })
  assert.deepEqual(parseDecisionInput('   '), { mode: 'pick', arg: '' })
  assert.deepEqual(parseDecisionInput(null), { mode: 'pick', arg: '' })
})

test('/decision <filename> keeps the relative path', () => {
  assert.deepEqual(parseDecisionInput('spec.md'), { mode: 'file', arg: 'spec.md' })
  assert.deepEqual(parseDecisionInput('docs/spec.md'), { mode: 'file', arg: 'docs/spec.md' })
  assert.deepEqual(parseDecisionInput('  docs/spec.md  '), { mode: 'file', arg: 'docs/spec.md' })
})

test('matching quotes and a leading @ are stripped', () => {
  assert.deepEqual(parseDecisionInput('"docs/spec v2.md"'), { mode: 'file', arg: 'docs/spec v2.md' })
  assert.deepEqual(parseDecisionInput("'docs/spec v2.md'"), { mode: 'file', arg: 'docs/spec v2.md' })
  assert.deepEqual(parseDecisionInput('@docs/spec.md'), { mode: 'file', arg: 'docs/spec.md' })
  // Unmatched quotes are part of the name, not syntax.
  assert.deepEqual(parseDecisionInput('"spec.md'), { mode: 'file', arg: '"spec.md' })
})

test('only text-like documents are accepted', () => {
  for (const path of ['a.md', 'b.MD', 'c.txt', 'd.json', 'e.yaml', 'f.yml', 'g.html', 'h.markdown']) {
    assert.equal(isDocumentPath(path), true, path)
  }
  for (const path of ['a.docx', 'b.pdf', 'c.png', 'd']) {
    assert.equal(isDocumentPath(path), false, path)
  }
})

test('workspace containment rejects parent traversal', () => {
  assert.equal(isPathInside('C:/work/project', 'C:/work/project/docs/spec.md'), true)
  assert.equal(isPathInside('C:/work/project', 'C:/work/project'), true)
  assert.equal(isPathInside('C:/work/project', 'C:/work/other/spec.md'), false)
})

test('paths are stored with forward slashes', () => {
  assert.equal(toPosixPath('docs\\sub\\spec.md'), 'docs/sub/spec.md')
})
