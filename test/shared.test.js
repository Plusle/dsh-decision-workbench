import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DECISION_LIMIT,
  buildDigest,
  countDecisions,
  decisionText,
  isDocumentPath,
  isPathInside,
  normalizeAskText,
  normalizeDecisionPayload,
  normalizeExplanationPayload,
  normalizeOptionsPayload,
  normalizePriority,
  parseDecisionInput,
  parseJsonPayload,
  pickExcerpt,
  slugify,
  toPosixPath,
  truncateDocument,
} from '../src/shared.js'

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

test('documents are truncated on a line boundary at the model budget', () => {
  const short = '第一行\n第二行\n'
  assert.deepEqual(truncateDocument(short, 100), { text: short, truncated: false, totalChars: short.length })

  const long = `${'标题\n'}${'内容'.repeat(80)}\n最后一行`
  const cut = truncateDocument(long, 60)
  assert.equal(cut.truncated, true)
  assert.equal(cut.totalChars, long.length)
  assert.ok(cut.text.length <= 60)
  assert.ok(!cut.text.endsWith('内'))
})

test('excerpt centers on the quoted source or the cited line', () => {
  const document = `${'前置说明。\n'.repeat(20)}这里是幂等键的关键约束。\n${'后续内容。\n'.repeat(20)}`
  const byQuote = pickExcerpt(document, { quote: '幂等键的关键约束' }, 120)
  assert.ok(byQuote.includes('幂等键的关键约束'))
  assert.ok(byQuote.startsWith('…'))

  const lines = ['第一行', '第二行', '第三行关键内容', '第四行', '第五行'].join('\n')
  const byLine = pickExcerpt(lines, { line: 3 }, 40)
  assert.ok(byLine.includes('第三行关键内容'))

  assert.equal(pickExcerpt('短文档', {}, 100), '短文档')
})

test('JSON payloads survive fences and trailing commas', () => {
  assert.deepEqual(parseJsonPayload('{"a":1}'), { a: 1 })
  assert.deepEqual(parseJsonPayload('模型说：\n```json\n{"a": 2}\n```'), { a: 2 })
  assert.deepEqual(parseJsonPayload('前言 {"a": 3} 后记'), { a: 3 })
  assert.deepEqual(parseJsonPayload('{"a": [1, 2,],}'), { a: [1, 2] })
  assert.throws(() => parseJsonPayload('完全没有 JSON'), /不是可解析的 JSON/)
})

test('priority values accept Chinese labels and fall back to important', () => {
  assert.equal(normalizePriority('必决'), 'blocking')
  assert.equal(normalizePriority('关键'), 'blocking')
  assert.equal(normalizePriority('blocking'), 'blocking')
  assert.equal(normalizePriority('建议'), 'important')
  assert.equal(normalizePriority('可选'), 'optional')
  assert.equal(normalizePriority('optional'), 'optional')
  assert.equal(normalizePriority(undefined), 'important')
})

test('an enumeration payload becomes normalized decision items', () => {
  const payload = {
    title: '支付退款重构',
    decisions: [
      {
        title: '退款渠道',
        question: '退款打到哪里？',
        section: '3.2 退款',
        priority: '必决',
        context: '不同渠道影响对账和到账时效。',
        options: [
          { label: 'A 原路退回', tradeoff: '用户最熟悉，但依赖通道能力', bestWhen: '通道支持时', risk: '通道失败' },
          'B 钱包余额',
        ],
        recommendation: { label: 'A 原路退回', why: '符合用户预期' },
        line: 42,
        quote: '退款优先原路退回',
      },
      {
        title: '重试策略',
        question: '失败后重试几次？',
        priority: '建议',
        options: [],
        line: 88,
      },
      { title: '退款渠道', question: '退款打到哪里？', priority: '必决' },
      { question: '' },
    ],
  }

  const normalized = normalizeDecisionPayload(payload, { sourcePath: 'docs/payment.md' })
  assert.equal(normalized.title, '支付退款重构')
  assert.equal(normalized.items.length, 2)

  const first = normalized.items[0]
  assert.equal(first.id, 'd1')
  assert.equal(first.priority, 'blocking')
  assert.equal(first.optionsOrigin, 'spec')
  assert.equal(first.options.length, 2)
  assert.equal(first.options[0].id, 'o1')
  assert.equal(first.options[1].from, 'spec')
  assert.equal(first.recommendation.optionId, 'o1')
  assert.equal(first.recommendation.why, '符合用户预期')
  assert.deepEqual(first.source, { path: 'docs/payment.md', line: 42, quote: '退款优先原路退回' })
  assert.equal(first.status, 'unseen')
  assert.equal(first.explanationState, 'idle')
  assert.equal(first.threadState, 'idle')
  assert.deepEqual(first.thread, [])

  const second = normalized.items[1]
  assert.equal(second.priority, 'important')
  assert.equal(second.optionsOrigin, 'none')
  assert.deepEqual(second.options, [])
  assert.equal(second.source.line, 88)
})

test('the item count is capped and malformed entries are skipped', () => {
  const decisions = Array.from({ length: DECISION_LIMIT + 10 }, (_, index) => ({
    title: `决策 ${index + 1}`,
    question: `问题 ${index + 1}`,
  }))
  const normalized = normalizeDecisionPayload({ decisions })
  assert.equal(normalized.items.length, DECISION_LIMIT)
  assert.equal(normalizeDecisionPayload({ decisions: [null, 1, 'x'] }).items.length, 0)
})

test('option payloads accept a bare array and normalize the recommendation', () => {
  const normalized = normalizeOptionsPayload(
    {
      options: [
        { label: 'A 缓存前置', tradeoff: '命中率高，但要多一层依赖', bestWhen: '读多写少', risk: '一致性' },
        { label: 'B 直接查库', tradeoff: '简单，但压力大' },
      ],
      recommendation: 'A 缓存前置',
    },
    { origin: 'assistant' },
  )
  assert.equal(normalized.options.length, 2)
  assert.equal(normalized.options[0].from, 'assistant')
  assert.equal(normalized.recommendation.optionId, 'o1')

  const bare = normalizeOptionsPayload(['方案一', '方案二'])
  assert.equal(bare.options.length, 2)
  assert.equal(bare.recommendation, undefined)
})

test('explanations accept objects, strings and scenario variants', () => {
  const normalized = normalizeExplanationPayload({
    gist: '建议走原路退回。',
    whyNow: '需要在联调前定。',
    background: '退款链路要改造。',
    scenarios: [
      { if: '通道支持', then: '原路退回' },
      { condition: '通道不支持', result: '转人工' },
      { noise: true },
    ],
    impact: '选错会拉长对账。',
    assumptions: ['通道支持原路退回', ''],
    citations: [{ line: 12, quote: '原文' }],
  })
  assert.equal(normalized.gist, '建议走原路退回。')
  assert.equal(normalized.scenarios.length, 2)
  assert.equal(normalized.scenarios[1].if, '通道不支持')
  assert.deepEqual(normalized.assumptions, ['通道支持原路退回'])
  assert.equal(normalized.citations[0].line, 12)

  const fromText = normalizeExplanationPayload('纯文本解释')
  assert.equal(fromText.gist, '纯文本解释')
  assert.deepEqual(fromText.scenarios, [])
})

test('assistant answers lose accidental code fences', () => {
  assert.equal(normalizeAskText('```\n回答内容\n```'), '回答内容')
  assert.equal(normalizeAskText(' 普通回答 '), '普通回答')
})

test('decision text combines option labels and a custom answer', () => {
  const item = {
    options: [
      { id: 'o1', label: 'A 原路退回' },
      { id: 'o2', label: 'B 钱包余额' },
    ],
    decision: { optionIds: ['o2'], custom: '小额走钱包' },
  }
  assert.equal(decisionText(item), 'B 钱包余额；自定义补充：小额走钱包')
  const onlyCustom = { options: [], decision: { optionIds: [], custom: '人工审核' } }
  assert.equal(decisionText(onlyCustom), '自定义：人工审核')
  assert.equal(decisionText({ options: [], decision: null }), '')
})

test('the digest keeps decided, unsure, deferred and untouched items distinct', () => {
  const items = [
    {
      id: 'd1',
      title: '退款渠道',
      priority: 'blocking',
      status: 'decided',
      options: [{ id: 'o1', label: 'A 原路退回' }],
      decision: { optionIds: ['o1'], custom: '', rationale: '用户预期' },
      source: { path: 'docs/payment.md', line: 42 },
    },
    {
      id: 'd2',
      title: '重试策略',
      priority: 'important',
      status: 'unsure',
      options: [],
      source: { path: 'docs/payment.md', line: 88 },
    },
    {
      id: 'd3',
      title: '灰度维度',
      priority: 'optional',
      status: 'deferred',
      options: [],
      source: { path: 'docs/payment.md' },
    },
    {
      id: 'd4',
      title: '埋点方案',
      priority: 'optional',
      status: 'unseen',
      options: [],
      source: { path: 'docs/payment.md' },
    },
  ]

  const stats = countDecisions(items)
  assert.deepEqual(stats, { total: 4, decided: 1, unsure: 1, deferred: 1, unseen: 1, blockingLeft: 0 })

  const digest = buildDigest({ id: 'dw_1', title: '支付退款重构', source: { path: 'docs/payment.md' }, items })
  assert.match(digest, /统计：已决定 1 \/ 拿不准 1 \/ 稍后 1 \/ 未处理 1/)
  assert.match(digest, /## 已决定/)
  assert.match(digest, /## 拿不准/)
  assert.match(digest, /A 原路退回/)
  assert.match(digest, /用户预期/)
  assert.match(digest, /不得由你自行猜测或代替用户决定/)
  assert.match(digest, /docs\/payment\.md:88/)
})

test('blocking items that are not decided are counted', () => {
  const stats = countDecisions([
    { status: 'unseen', priority: 'blocking' },
    { status: 'decided', priority: 'blocking' },
    { status: 'unsure', priority: 'important' },
  ])
  assert.equal(stats.blockingLeft, 1)
})

test('file slugs are safe for a decision record filename', () => {
  assert.equal(slugify('支付退款 / 方案'), '支付退款-方案')
  assert.equal(slugify('  a  b  '), 'a-b')
  assert.equal(slugify('///'), 'decisions')
  assert.ok(slugify('x'.repeat(80)).length <= 48)
})
