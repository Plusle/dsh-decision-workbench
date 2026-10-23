import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DECISION_LIMIT,
  buildAgentNotice,
  buildCommandHint,
  buildDigest,
  buildExamplesPrompt,
  buildExplanationPrompt,
  buildFinishNotice,
  buildResolution,
  buildStartNotice,
  countDecisions,
  decisionText,
  findStaleItems,
  isDocumentPath,
  isPathInside,
  mergeDuplicateItems,
  normalizeAskText,
  normalizeDecisionPayload,
  normalizeExamplesPayload,
  normalizeExplanationPayload,
  normalizeOptionsPayload,
  normalizePriority,
  normalizeWorkspacePath,
  parseDecisionInput,
  parseJsonPayload,
  pickExcerpt,
  sameWorkspaceRoot,
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

// --- 0.3.0: workspace binding, duplicate merge, on-demand examples ------------

test('workspace roots are canonicalized before comparison', () => {
  const root = normalizeWorkspacePath('F:\\dsh-plugin\\demo')
  assert.equal(root.includes('\\'), false)
  assert.equal(normalizeWorkspacePath(''), '')
  assert.equal(normalizeWorkspacePath('   '), '')
  // Same directory written two ways must compare equal on this platform, and a
  // different directory must never be treated as the same workspace.
  assert.equal(sameWorkspaceRoot('F:\\dsh-plugin\\demo', root), true)
  assert.equal(sameWorkspaceRoot('F:/dsh-plugin/demo', root), true)
  assert.equal(sameWorkspaceRoot('F:/dsh-plugin/demo/nested', root), false)
  assert.equal(sameWorkspaceRoot('F:/dsh-plugin/other', root), false)
  assert.equal(sameWorkspaceRoot('', root), false)
})

test('near-duplicate decisions are merged and keep the richer data', () => {
  const base = {
    id: 'd1',
    title: '退款渠道',
    question: '退款打到哪里？',
    priority: 'optional',
    options: [],
    optionsOrigin: 'none',
    source: { path: 'spec.md', line: 42 },
  }
  const duplicate = {
    id: 'd2',
    title: '退款渠道（微信）',
    question: '退款打到哪里？',
    priority: 'blocking',
    options: [{ id: 'o1', label: '原路退回', from: 'spec' }],
    optionsOrigin: 'spec',
    recommendation: { optionId: 'o1', why: '用户预期' },
    source: { path: 'spec.md' },
  }
  const distinct = { id: 'd3', title: '重试策略', question: '失败后重试几次？', priority: 'important', options: [] }

  const merged = mergeDuplicateItems([base, duplicate, distinct])
  assert.equal(merged.merged, 1)
  assert.equal(merged.items.length, 2)
  const first = merged.items[0]
  assert.equal(first.id, 'd1')
  // A merged row keeps the strongest priority and anything the canonical lacked.
  assert.equal(first.priority, 'blocking')
  assert.equal(first.options.length, 1)
  assert.equal(first.optionsOrigin, 'spec')
  assert.equal(first.source.line, 42)
  assert.equal(first.mergedFrom.length, 1)
  assert.equal(first.mergedFrom[0].id, 'd2')
  assert.equal(merged.items[1].title, '重试策略')
  assert.equal(merged.items[1].mergedFrom, undefined)

  const noMerge = mergeDuplicateItems([base, { ...base, id: 'd9', title: '灰度维度', question: '灰度按什么维度切？' }])
  assert.equal(noMerge.merged, 0)
  assert.equal(noMerge.items.length, 2)
})

test('example payloads normalize objects, strings and a note', () => {
  const normalized = normalizeExamplesPayload({
    examples: [
      { if: '选择自动退款', then: '超时订单会直接退回，对账需要补一条冲正' },
      { condition: '一直不决定', result: '订单挂在待处理里，客服每天手工清' },
      '第三种只是写清楚结果',
    ],
    note: '以上基于文档现有流程。',
  })
  assert.equal(normalized.examples.length, 3)
  assert.equal(normalized.examples[0].if, '选择自动退款')
  assert.equal(normalized.examples[1].if, '一直不决定')
  assert.equal(normalized.examples[2].if, '')
  assert.equal(normalized.examples[2].then, '第三种只是写清楚结果')
  assert.equal(normalized.note, '以上基于文档现有流程。')

  assert.deepEqual(normalizeExamplesPayload(null).examples, [])
  const capped = normalizeExamplesPayload({ examples: Array.from({ length: 9 }, (_, index) => ({ if: `条件${index}`, then: '结果' })) })
  assert.ok(capped.examples.length <= 4)
})

test('stale citations are detected by quote and by line number', () => {
  const document = ['第一行', '第二行：幂等键用订单号', '第三行'].join('\n')
  const items = [
    { id: 'd1', source: { quote: '幂等键用订单号' } },
    { id: 'd2', source: { quote: '这句话已经不存在' } },
    { id: 'd3', source: { line: 99 } },
    { id: 'd4', source: { line: 2 } },
    { id: 'd5', source: {} },
  ]
  assert.deepEqual(findStaleItems(document, items), ['d2', 'd3'])
  assert.deepEqual(findStaleItems(document, [{ id: 'd9' }]), [])
})

test('prompts keep explanation and examples as separate asks', () => {
  const item = { title: '退款渠道', question: '退款打到哪里？', context: '', options: [], thread: [] }
  const explanation = buildExplanationPrompt({ item, excerpt: '片段', sourcePath: 'spec.md' })
  assert.ok(explanation.system.includes('不要写具体场景'))
  assert.equal(explanation.system.includes('"scenarios"'), false)

  const examples = buildExamplesPrompt({ item, excerpt: '片段', sourcePath: 'spec.md' })
  assert.ok(examples.system.includes('"examples"'))
  assert.ok(examples.system.includes('如果'))
  assert.ok(examples.user.includes('spec.md'))
})

test('a stale source is noted in the digest', () => {
  const digest = buildDigest({
    id: 'dw_stale',
    title: '支付重构',
    source: { path: 'spec.md', stale: true },
    items: [{ id: 'd1', title: '退款渠道', status: 'decided', priority: 'blocking', options: [{ id: 'o1', label: 'A' }], decision: { optionIds: ['o1'] }, source: { path: 'spec.md' } }],
  })
  assert.match(digest, /来源文档在该工作台打开后发生过变化/)
})
test('command result hints follow the locale', () => {
  assert.match(buildCommandHint({ locale: 'zh', mode: 'pick' }), /决策工作台已打开/)
  assert.match(buildCommandHint({ locale: 'en', mode: 'pick' }), /Decision Workbench opened/)
  assert.match(
    buildCommandHint({ locale: 'en', mode: 'file', path: 'docs/spec.md' }),
    /Opening Decision Workbench: docs\/spec\.md/,
  )
  assert.match(
    buildCommandHint({ locale: 'zh', mode: 'file', path: 'docs/spec.md' }),
    /正在打开决策工作台：docs\/spec\.md/,
  )
})

test('start and finish notices ask the session to acknowledge without acting', () => {
  const start = buildStartNotice({ sourcePath: 'docs/spec.md', locale: 'zh' })
  assert.match(start, /\[决策工作台\] 工作开始/)
  assert.match(start, /输入文件：docs\/spec\.md/)
  assert.match(start, /只回复“收到，等待结果”/)
  assert.match(start, /不要开始实施/)

  const finish = buildFinishNotice({
    sourcePath: 'docs/spec.md',
    resolutionPath: 'docs/decisions/2026-10-20-spec.md',
    stats: { decided: 5, unsure: 1, deferred: 0, unseen: 2 },
    locale: 'zh',
  })
  assert.match(finish, /\[决策工作台\] 工作完成/)
  assert.match(finish, /结果文件：docs\/decisions\/2026-10-20-spec\.md/)
  assert.match(finish, /已决定 5 \/ 拿不准 1 \/ 稍后 0 \/ 未处理 2/)
  assert.match(finish, /不要读取结果文件/)
  assert.match(finish, /等待用户下一步指令/)

  const auto = buildFinishNotice({
    sourcePath: 'docs/spec.md',
    resolutionPath: 'docs/decisions/2026-10-20-spec.md',
    stats: { decided: 1 },
    autoRead: true,
    locale: 'zh',
  })
  assert.match(auto, /请读取结果文件/)
  assert.match(auto, /立即按其中「已决定」的项开始执行/)
  assert.match(auto, /不要先回复确认/)
  assert.doesNotMatch(auto, /只回复“收到”/)

  const startEn = buildStartNotice({ sourcePath: 'docs/spec.md', locale: 'en' })
  assert.match(startEn, /\[Decision Workbench\] Work started/)
  assert.match(startEn, /Input file: docs\/spec\.md/)
  assert.match(startEn, /Received, waiting for the result/)
  assert.match(startEn, /do not start implementing/)

  const finishEn = buildFinishNotice({
    sourcePath: 'docs/spec.md',
    resolutionPath: 'docs/decisions/2026-10-20-spec.md',
    stats: { decided: 5, unsure: 1, deferred: 0, unseen: 2 },
    locale: 'en',
  })
  assert.match(finishEn, /\[Decision Workbench\] Work completed/)
  assert.match(finishEn, /Result file: docs\/decisions\/2026-10-20-spec\.md/)
  assert.match(finishEn, /Stats: decided 5 \/ unsure 1 \/ deferred 0 \/ untouched 2/)
  assert.match(finishEn, /Do not read the result file/)

  const autoEn = buildFinishNotice({
    sourcePath: 'docs/spec.md',
    resolutionPath: 'docs/decisions/2026-10-20-spec.md',
    stats: { decided: 1 },
    autoRead: true,
    locale: 'en',
  })
  assert.match(autoEn, /Read the result file/)
  assert.match(autoEn, /immediately start implementing the decided items/)
  assert.match(autoEn, /do not reply with an acknowledgement first/)
  assert.doesNotMatch(autoEn, /reply only "Received"/)
})

test('a notice reaches the session as a complete user message', () => {
  const message = buildAgentNotice('[决策工作台] 工作开始', 'notice-1')
  // The session log stores this object as-is and the provider rejects a request
  // whose message lacks `role`, so both identifying fields are required.
  assert.equal(message.role, 'user')
  assert.equal(message.id, 'notice-1')
  assert.deepEqual(message.content, [{ type: 'text', text: '[决策工作台] 工作开始' }])
  assert.deepEqual(message.source, { kind: 'user' })
})

test('the resolution file wraps the digest with source and workbench metadata', () => {
  const resolution = buildResolution(
    {
      id: 'dw_1',
      title: '支付重构',
      source: { path: 'docs/pay.md' },
      items: [
        { id: 'd1', title: '退款渠道', status: 'decided', priority: 'blocking', options: [{ id: 'o1', label: '微信原路退回' }], decision: { optionIds: ['o1'], rationale: '改动最小' }, source: { path: 'docs/pay.md', line: 3 } },
      ],
    },
    { generatedAt: '2026-10-20 13:00' },
  )
  assert.match(resolution, /^# 决策结果：支付重构/m)
  assert.match(resolution, /> 来源：`docs\/pay\.md`/)
  assert.match(resolution, /> 完成时间：2026-10-20 13:00/)
  assert.match(resolution, /> 工作台：dw_1/)
  assert.match(resolution, /## 已决定（1 项）/)
  assert.match(resolution, /微信原路退回/)
})
