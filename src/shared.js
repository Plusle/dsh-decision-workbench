// dsh-decision-workbench - pure helpers shared by the host half and its tests.
//
// Nothing here touches the Cordis context, the filesystem, or the network, so
// the command parser, the model-output normalizers and the digest builder can
// be tested without a Harness process.
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const PLUGIN_ID = 'dsh-decision-workbench'
export const COMMAND_NAME = 'decision'
export const ROUTE_PREFIX = '/dsh-decision-workbench'

// Text-like documents a decision pass can read. Binary documents are rejected
// with a clear message instead of being half-parsed.
export const DOCUMENT_EXTENSIONS = Object.freeze([
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.rst',
  '.adoc',
  '.json',
  '.yaml',
  '.yml',
  '.html',
])

// Hard limits. They keep one pathological document from turning into an
// unbounded model request, and keep the panel digest readable.
export const DECISION_LIMIT = 40
export const MAX_DOCUMENT_CHARS = 60_000
export const MAX_QUESTION_CHARS = 2_000
export const MAX_OPTIONS = 6
export const MIN_OPTIONS = 2
export const MAX_EXAMPLES = 4
// Two enumerated items whose normalized title+question cross this Dice
// similarity are treated as the same decision and merged into one row.
export const DECISION_SIMILARITY = 0.82

export const PRIORITIES = Object.freeze(['blocking', 'important', 'optional'])
export const ITEM_STATUSES = Object.freeze(['unseen', 'decided', 'unsure', 'deferred'])
export const WORKBENCH_STATUSES = Object.freeze(['generating', 'ready', 'failed', 'submitted'])

// --- command parsing ---------------------------------------------------------

/**
 * Parse the `/decision` argument.
 *
 *   /decision                     -> { mode: 'pick', arg: '' }
 *   /decision spec.md             -> { mode: 'file', arg: 'spec.md' }
 *   /decision "docs/spec v2.md"   -> { mode: 'file', arg: 'docs/spec v2.md' }
 *   /decision @docs/spec.md       -> { mode: 'file', arg: 'docs/spec.md' }
 *
 * The whole argument (after stripping matching quotes and one leading `@`) is
 * treated as one filename, so spaces need quotes exactly like a shell.
 */
export function parseDecisionInput(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return { mode: 'pick', arg: '' }

  let arg = text
  if (arg.startsWith('@')) arg = arg.slice(1)
  const first = arg[0]
  const last = arg[arg.length - 1]
  if (arg.length >= 2 && (first === '"' || first === "'") && last === first) {
    arg = arg.slice(1, -1)
  }
  arg = arg.trim()
  if (arg === '') return { mode: 'pick', arg: '' }
  return { mode: 'file', arg }
}

export function isDocumentPath(path) {
  const lower = String(path ?? '').toLowerCase()
  return DOCUMENT_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

/** True when `target` resolves to `root` or lives below it. */
export function isPathInside(root, target) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Normalize a path for storage and display: forward slashes on every OS. */
export function toPosixPath(path) {
  return String(path ?? '').split(sep).join('/')
}

// --- workspace identity ------------------------------------------------------

/**
 * Canonical form of a workspace root, used as the workbench's binding key.
 * A workbench belongs to exactly one (session, workspace) pair: the same
 * session that later switches its working directory must not reach it.
 */
export function normalizeWorkspacePath(path) {
  const text = String(path ?? '').trim()
  if (text === '') return ''
  return toPosixPath(resolve(text))
}

/** Compare two workspace roots after canonicalization. */
export function sameWorkspaceRoot(left, right) {
  const a = normalizeWorkspacePath(left)
  const b = normalizeWorkspacePath(right)
  if (a === '' || b === '') return false
  // Windows and macOS compare paths case-insensitively; Linux does not.
  if (process.platform === 'win32' || process.platform === 'darwin') return a.toLowerCase() === b.toLowerCase()
  return a === b
}

// --- text helpers ------------------------------------------------------------

export function clampText(value, max) {
  const text = typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value).trim()
  if (text === '') return ''
  if (text.length <= max) return text
  return `${text.slice(0, max).trimEnd()}…`
}

function textOf(value, max = 2_000) {
  return clampText(typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value), max)
}

/**
 * Cut a document down to the model budget, preferring a line boundary so the
 * excerpt does not end in the middle of a sentence.
 */
export function truncateDocument(text, maxChars = MAX_DOCUMENT_CHARS) {
  const source = String(text ?? '')
  if (source.length <= maxChars) {
    return { text: source, truncated: false, totalChars: source.length }
  }
  let cut = source.slice(0, maxChars)
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('。'), cut.lastIndexOf('. '))
  if (lastBreak > maxChars - 2_000) cut = cut.slice(0, lastBreak + 1)
  return { text: cut, truncated: true, totalChars: source.length }
}

/**
 * Pull the excerpt that best explains one decision: around its quoted source
 * when the quote is findable, otherwise around its line number, otherwise the
 * head of the document.
 */
export function pickExcerpt(text, source = {}, budget = 8_000) {
  const document = String(text ?? '')
  if (document === '') return ''
  if (document.length <= budget) return document

  const quote = textOf(source.quote, 240)
  if (quote !== '') {
    const index = document.indexOf(quote)
    if (index >= 0) return aroundOffset(document, index, quote.length, budget)
  }

  const line = Number(source.line)
  if (Number.isFinite(line) && line > 0) {
    const lines = document.split('\n')
    const target = Math.min(lines.length - 1, Math.max(0, Math.floor(line) - 1))
    let offset = 0
    for (let index = 0; index < target; index += 1) offset += lines[index].length + 1
    return aroundOffset(document, offset, 0, budget)
  }

  return truncateDocument(document, budget).text
}

function aroundOffset(document, offset, length, budget) {
  const half = Math.max(1, Math.floor((budget - length) / 2))
  let start = Math.max(0, offset - half)
  let end = Math.min(document.length, offset + length + half)
  if (start > 0) {
    const newline = document.indexOf('\n', start)
    if (newline >= 0 && newline < offset) start = newline + 1
  }
  if (end < document.length) {
    const newline = document.lastIndexOf('\n', end)
    if (newline > offset + length) end = newline
  }
  const prefix = start > 0 ? '…' : ''
  const suffix = end < document.length ? '…' : ''
  return `${prefix}${document.slice(start, end)}${suffix}`
}

// --- JSON extraction ---------------------------------------------------------

/**
 * Models sometimes wrap JSON in a fenced block or add a sentence before it.
 * Extract the outer object and repair the two most common syntax slips.
 */
export function parseJsonPayload(raw) {
  const parsed = tryParseJson(raw)
  if (parsed !== undefined) return parsed
  throw new Error('模型返回的内容不是可解析的 JSON。')
}

function tryParseJson(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '').trim()
  if (text === '') return undefined

  const candidates = []
  const fenced = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/)
  if (fenced) candidates.push(fenced[1].trim())
  candidates.push(text)

  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1))

  for (const candidate of candidates) {
    const direct = parseOne(candidate)
    if (direct !== undefined) return direct
  }
  return undefined
}

function parseOne(candidate) {
  if (candidate === '') return undefined
  try {
    return JSON.parse(candidate)
  } catch {
    // retry after repairing trailing commas
  }
  try {
    return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'))
  } catch {
    return undefined
  }
}

// --- normalization -----------------------------------------------------------

function asArray(value) {
  if (Array.isArray(value)) return value
  if (value === undefined || value === null || value === '') return []
  return [value]
}

export function normalizePriority(value) {
  const text = textOf(value, 40).toLowerCase()
  if (text === '') return 'important'
  if (/^(blocking|blocker|critical|must|required|必决|必须|阻塞|关键|高)$/.test(text)) return 'blocking'
  if (/^(optional|nice|low|someday|可选|次要|低|可以后补)$/.test(text)) return 'optional'
  return 'important'
}

function normalizeSource(raw, fallbackPath) {
  const object = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const path = textOf(object.path, 512) || textOf(fallbackPath, 512)
  const lineNumber = Number(object.line ?? object.lineNumber ?? object.sourceLine)
  const line = Number.isFinite(lineNumber) && lineNumber > 0 ? Math.floor(lineNumber) : undefined
  const quote = textOf(object.quote ?? object.excerpt ?? object.text, 300)
  const source = { path }
  if (line !== undefined) source.line = line
  if (quote !== '') source.quote = quote
  return source
}

function coreLabel(label) {
  return textOf(label, 120)
    .toLowerCase()
    .replace(/^[a-z][\s.、,:：)）-]+/, '')
    .replace(/^[（(【\[]?\s*[a-z0-9]{1,2}\s*[)）】\]]?[\s.、,:：-]*/, '')
    .trim()
}

function matchOptionId(options, reference) {
  const ref = textOf(reference, 120).toLowerCase()
  if (ref === '') return undefined
  const exact = options.find((option) => option.label.toLowerCase() === ref)
  if (exact) return exact.id
  const prefix = options.find(
    (option) => option.label.toLowerCase().startsWith(ref) || ref.startsWith(option.label.toLowerCase()),
  )
  if (prefix) return prefix.id
  const refCore = coreLabel(ref)
  if (refCore !== '') {
    const byCore = options.find((option) => coreLabel(option.label) === refCore)
    if (byCore) return byCore.id
    const byContains = options.find((option) => {
      const core = coreLabel(option.label)
      return core !== '' && (core.includes(refCore) || refCore.includes(core))
    })
    if (byContains) return byContains.id
  }
  return undefined
}

export function normalizeOption(raw, index, from = 'spec') {
  const object = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const label = textOf(
    typeof raw === 'string' ? raw : object.label ?? object.name ?? object.title ?? object.option ?? object.text,
    120,
  )
  if (label === '') return undefined
  return {
    id: `o${index + 1}`,
    label,
    tradeoff: textOf(object.tradeoff ?? object.rationale ?? object.why ?? object.description ?? object.desc ?? object.benefit, 400),
    bestWhen: textOf(object.bestWhen ?? object.when ?? object.fit ?? object.condition, 240),
    risk: textOf(object.risk ?? object.cons ?? object.downside ?? object.cost, 240),
    from,
  }
}

function normalizeRecommendation(raw, options) {
  if (raw === undefined || raw === null || raw === '') return undefined
  const object = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const label = typeof raw === 'string' ? raw : object.label ?? object.option ?? object.name ?? object.optionId
  const why = textOf(object.why ?? object.reason ?? object.rationale ?? object.explanation, 300)
  let optionId
  if (typeof object.optionId === 'string' && options.some((option) => option.id === object.optionId)) {
    optionId = object.optionId
  } else {
    optionId = matchOptionId(options, label)
  }
  if (optionId === undefined) return undefined
  return { optionId, why }
}

export function normalizeOptionsPayload(raw, options = {}) {
  const origin = options.origin === 'spec' ? 'spec' : options.origin === 'user' ? 'user' : 'assistant'
  const container = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const list = Array.isArray(raw) ? raw : asArray(container.options ?? container.alternatives ?? container.choices)
  const normalized = []
  for (const entry of list) {
    if (normalized.length >= MAX_OPTIONS) break
    const option = normalizeOption(entry, normalized.length, origin)
    if (option !== undefined) normalized.push(option)
  }
  return {
    options: normalized,
    recommendation: normalizeRecommendation(container.recommendation ?? container.recommended ?? container.recommend, normalized),
  }
}

/**
 * Normalize one enumeration payload into the workbench item shape.
 *
 * Accepts `{ title, decisions: [...] }`, `{ items: [...] }` and a bare array,
 * because a model can legitimately answer any of those despite the schema.
 */
export function normalizeDecisionPayload(raw, options = {}) {
  const sourcePath = textOf(options.sourcePath, 512)
  const container = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const documentTitle = textOf(container.title ?? container.documentTitle ?? container.name, 160)
  const list = Array.isArray(raw) ? raw : asArray(container.decisions ?? container.items ?? container.questions)

  const items = []
  const seen = new Set()
  for (const entry of list) {
    if (items.length >= DECISION_LIMIT) break
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue

    const title = textOf(entry.title ?? entry.name ?? entry.heading, 120)
    const question = textOf(entry.question ?? entry.description ?? entry.detail ?? entry.prompt, 600)
    const fallbackTitle = textOf(question || entry.context, 40)
    const finalTitle = title || fallbackTitle
    if (finalTitle === '') continue

    const dedupeKey = `${finalTitle.toLowerCase()}|${question.toLowerCase()}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    const normalizedOptions = normalizeOptionsPayload({ options: entry.options, recommendation: entry.recommendation }, { origin: 'spec' })
    const priority = normalizePriority(entry.priority ?? entry.level ?? entry.urgency)

    const item = {
      id: `d${items.length + 1}`,
      title: finalTitle,
      question: question || finalTitle,
      context: textOf(entry.context ?? entry.background ?? entry.why, 400),
      priority,
      status: 'unseen',
      source: normalizeSource(entry.source ?? { line: entry.line, quote: entry.quote }, sourcePath),
      optionsOrigin: normalizedOptions.options.length > 0 ? 'spec' : 'none',
      options: normalizedOptions.options,
      recommendation: normalizedOptions.recommendation,
      explanationState: 'idle',
      examplesState: 'idle',
      optionsState: 'idle',
      threadState: 'idle',
      thread: [],
    }
    if (textOf(entry.section, 120) !== '') item.section = textOf(entry.section, 120)
    items.push(item)
    if (normalizedOptions.options.length === 0) item.optionsOrigin = 'none'
  }

  return { title: documentTitle, items }
}

/** Fold one duplicate item into the canonical one, keeping the richer data. */
function absorbDecision(canonical, duplicate) {
  const aliases = Array.isArray(canonical.mergedFrom) ? canonical.mergedFrom : []
  aliases.push({
    id: typeof duplicate.id === 'string' ? duplicate.id : '',
    title: textOf(duplicate.title, 120),
    question: textOf(duplicate.question, 600),
  })
  canonical.mergedFrom = aliases

  const rank = { optional: 0, important: 1, blocking: 2 }
  if ((rank[duplicate.priority] ?? 0) > (rank[canonical.priority] ?? 0)) canonical.priority = duplicate.priority

  const canonicalOptions = Array.isArray(canonical.options) ? canonical.options : []
  const duplicateOptions = Array.isArray(duplicate.options) ? duplicate.options : []
  if (canonicalOptions.length === 0 && duplicateOptions.length > 0) {
    canonical.options = duplicateOptions
    canonical.optionsOrigin = duplicate.optionsOrigin || 'spec'
    canonical.recommendation = duplicate.recommendation
  }
  if (!canonical.context && duplicate.context) canonical.context = duplicate.context
  if (canonical.source && duplicate.source) {
    if (canonical.source.line === undefined && duplicate.source.line !== undefined) canonical.source.line = duplicate.source.line
    if (!canonical.source.quote && duplicate.source.quote) canonical.source.quote = duplicate.source.quote
  }
}

function normalizeForSimilarity(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

function bigramSet(text) {
  const set = new Set()
  for (let index = 0; index < text.length - 1; index += 1) set.add(text.slice(index, index + 2))
  return set
}

function diceSimilarity(left, right) {
  if (left === right) return 1
  if (left.length < 2 || right.length < 2) return 0
  const a = bigramSet(left)
  const b = bigramSet(right)
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared += 1
  return (2 * shared) / (a.size + b.size)
}

/**
 * Merge decisions that the model listed twice under slightly different
 * wording. The first item stays the canonical row; later near-duplicates are
 * folded in (their options, line and title become an alias), so the panel
 * shows one row instead of two half-identical questions.
 *
 * Two rows count as the same decision when their normalized title+question are
 * almost identical, or when the question matches and the titles are close.
 */
export function mergeDuplicateItems(items = [], options = {}) {
  const threshold = Number.isFinite(options.threshold) ? options.threshold : DECISION_SIMILARITY
  const kept = []
  const signatures = []
  let merged = 0

  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const title = normalizeForSimilarity(textOf(item.title, 120))
    const question = normalizeForSimilarity(textOf(item.question, 600))
    const signature = `${title}${question}`
    if (signature === '') {
      kept.push(item)
      signatures.push({ title: '', question: '', signature: '' })
      continue
    }
    const canonicalIndex = signatures.findIndex((other) => {
      if (other.signature === '') return false
      if (other.signature === signature) return true
      // Same question + nearly same title is the same decision even when one
      // title carries a parenthetical qualifier.
      if (other.question !== '' && question !== '' && other.question === question) {
        if (other.title === '' || title === '') return true
        return (
          diceSimilarity(other.title, title) >= 0.5 || other.title.includes(title) || title.includes(other.title)
        )
      }
      return diceSimilarity(other.signature, signature) >= threshold
    })
    if (canonicalIndex < 0) {
      kept.push(item)
      signatures.push({ title, question, signature })
      continue
    }
    absorbDecision(kept[canonicalIndex], item)
    merged += 1
  }

  return { items: kept, merged }
}

/** Item ids whose quote vanished from the document, or whose line no longer exists. */
export function findStaleItems(text, items = []) {
  const document = String(text ?? '')
  const lineCount = document === '' ? 0 : document.split('\n').length
  const stale = []
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item.id !== 'string') continue
    const source = item.source && typeof item.source === 'object' ? item.source : {}
    let invalid = false
    if (typeof source.quote === 'string' && source.quote !== '') {
      invalid = !document.includes(source.quote)
    } else {
      const line = Number(source.line)
      if (Number.isFinite(line) && line > lineCount) invalid = true
    }
    if (invalid) stale.push(item.id)
  }
  return stale
}

export function normalizeExplanationPayload(raw, fallback = {}) {
  if (typeof raw === 'string' && raw.trim() !== '') {
    return {
      gist: clampText(raw, 400),
      whyNow: '',
      background: '',
      scenarios: [],
      impact: '',
      assumptions: [],
      citations: [],
    }
  }
  const object = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const scenarios = []
  for (const scenario of asArray(object.scenarios ?? object.cases ?? object.ifThen)) {
    if (!scenario || typeof scenario !== 'object') continue
    const condition = textOf(scenario.if ?? scenario.condition ?? scenario.when, 200)
    const then = textOf(scenario.then ?? scenario.result ?? scenario.effect, 240)
    if (condition === '' && then === '') continue
    scenarios.push({ if: condition, then })
    if (scenarios.length >= 4) break
  }
  const assumptions = asArray(object.assumptions ?? object.caveats)
    .map((entry) => textOf(entry, 200))
    .filter((entry) => entry !== '')
    .slice(0, 5)
  const citations = asArray(object.citations ?? object.references)
    .map((entry) => normalizeSource(entry, fallback.path))
    .filter((entry) => entry.quote !== undefined || entry.line !== undefined)
    .slice(0, 5)
  return {
    gist: textOf(object.gist ?? object.summary ?? object.oneLiner, 400) || textOf(fallback.gist, 400),
    whyNow: textOf(object.whyNow ?? object.why ?? object.urgency, 400),
    background: textOf(object.background ?? object.context, 800),
    scenarios,
    impact: textOf(object.impact ?? object.consequence ?? object.risk, 500),
    assumptions,
    citations,
  }
}

export function normalizeExamplesPayload(raw, fallback = {}) {
  const object = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const list = Array.isArray(raw) ? raw : asArray(object.examples ?? object.scenarios ?? object.cases ?? object.ifThen)
  const examples = []
  for (const entry of list) {
    if (examples.length >= MAX_EXAMPLES) break
    if (entry === null || entry === undefined) continue
    if (typeof entry !== 'object' || Array.isArray(entry)) {
      // A bare sentence is still a usable example; render it as the outcome.
      const sentence = textOf(entry, 400)
      if (sentence === '') continue
      examples.push({ if: '', then: sentence })
      continue
    }
    const condition = textOf(entry.if ?? entry.condition ?? entry.when ?? entry.scenario, 200)
    const then = textOf(entry.then ?? entry.result ?? entry.effect ?? entry.outcome ?? entry.example, 400)
    if (condition === '' && then === '') continue
    examples.push({ if: condition, then })
  }
  return {
    examples,
    note: textOf(object.note ?? object.caveat ?? object.assumption, 240) || textOf(fallback.note, 240),
  }
}

export function normalizeAskText(raw) {
  const text = String(raw ?? '')
    .replace(/^```[a-zA-Z]*\s*\n?/, '')
    .replace(/```\s*$/, '')
    .trim()
  return text
}

// --- prompts -----------------------------------------------------------------

export function buildEnumerationPrompt({ documentText, sourcePath, truncated = false, totalChars = 0 }) {
  const system = [
    '你是「决策工作台」的决策分析助手，在一个独立、只读的分析上下文里工作。',
    '你的唯一任务：从用户给出的项目文档（通常是 spec / 需求稿 / 技术方案）中，找出所有需要人来拍板、选择或确认的决策点，并整理成结构化 JSON。',
    '规则：',
    '1. 只输出 JSON，不要输出解释、前言、Markdown 代码块标记或任何额外文字。',
    '2. 每个决策点必须是文档里真实存在或明确隐含的待决问题；不要编造文档没有提及的方向。',
    '3. 文档有备选方案时，原样提取（可轻度改写为更清楚的表述）；不要自行新增方案。',
    '4. 文档没有给出备选方案时，options 用空数组 []，不要替用户发明选项。',
    '5. priority 取 blocking（不决定就无法开工/上线）、important（影响方案质量但可后补）、optional（可以以后再说）。',
    '6. line 是问题在文档中的大致行号（从 1 开始）；quote 是能定位该问题的原文片段，不超过 80 字。',
    '7. 按文档顺序排列，最多 30 项（优先必决与建议）；文档没有任何需要决策的点时返回空数组。',
    '8. 不要输出解释、背景段落或具体实例：讲解与实例在用户打开某一项时才按需生成。',
    'JSON 结构：',
    '{"title":"文档标题","decisions":[{"title":"短标题（不超过20字）","question":"要决定的问题，一句话","section":"所在章节","priority":"blocking|important|optional","options":[{"label":"方案名","tradeoff":"代价与收益","bestWhen":"什么情况下选它","risk":"主要风险"}],"recommendation":{"label":"推荐的方案名","why":"一句理由"},"line":12,"quote":"原文片段"}]}',
  ].join('\n')

  const notice = truncated
    ? `\n（文档共 ${totalChars} 字，因长度限制只提供了前 ${documentText.length} 字，可能不完整。）\n`
    : '\n'
  const user = [
    `文档路径：${sourcePath}`,
    notice,
    '--- 文档开始 ---',
    documentText,
    '--- 文档结束 ---',
    '',
    '请找出全部决策点，并只输出符合上述结构的 JSON。',
  ].join('\n')
  return { system, user }
}

function decidedLines(items = []) {
  return items
    .filter((item) => item.status === 'decided')
    .slice(0, 12)
    .map((item) => `- ${item.title}：${decisionText(item)}`)
}

export function buildExplanationPrompt({ item, excerpt, sourcePath, decided = [] }) {
  const system = [
    '你是决策分析助手。基于给定的文档片段，为一个决策点写一份能直接帮助人做决定的说明。',
    '只输出 JSON：',
    '{"gist":"一句话结论（不超过60字）","whyNow":"为什么现在要决定（不超过80字）","background":"背景（不超过200字）","impact":"不决定或选错的后果（不超过120字）","assumptions":["需要确认的假设"],"citations":[{"line":12,"quote":"原文不超过60字"}]}',
    '不要引入文档没有的事实；无法确定的内容写进 assumptions，不要编造引用。',
    '这里只要解释，不要写具体场景或实例——用户会单独要求例子。',
  ].join('\n')
  const optionText = item.options.length > 0
    ? item.options.map((option) => `- ${option.label}${option.tradeoff ? `：${option.tradeoff}` : ''}`).join('\n')
    : '（文档没有给出备选方案）'
  const prior = decidedLines(decided)
  const user = [
    `文档路径：${sourcePath}`,
    '',
    `决策标题：${item.title}`,
    `需要决定的问题：${item.question}`,
    item.context ? `文档中的背景：${item.context}` : '',
    `已有的备选方案：\n${optionText}`,
    prior.length > 0 ? `\n同一份文档中已经做出的决定（保持一致性）：\n${prior.join('\n')}` : '',
    '',
    '相关文档片段：',
    '--- 片段开始 ---',
    excerpt,
    '--- 片段结束 ---',
    '',
    '请只输出上述 JSON。',
  ].filter((line) => line !== '').join('\n')
  return { system, user }
}

export function buildOptionsPrompt({ item, excerpt, sourcePath }) {
  const system = [
    '你是决策分析助手。文档没有为这个决策点给出备选方案，请补充 2–4 个互斥、可执行的方案，并给出推荐。',
    '只输出 JSON：',
    '{"options":[{"label":"不超过12字","tradeoff":"代价与收益（不超过80字）","bestWhen":"适用条件（不超过40字）","risk":"主要风险（不超过40字）"}],"recommendation":{"label":"推荐的方案名","why":"不超过60字"}}',
    '方案必须贴合文档已有的约束，不要引入文档未提及的新技术栈或新前提。',
  ].join('\n')
  const user = [
    `文档路径：${sourcePath}`,
    `决策标题：${item.title}`,
    `需要决定的问题：${item.question}`,
    item.context ? `文档中的背景：${item.context}` : '',
    '',
    '相关文档片段：',
    '--- 片段开始 ---',
    excerpt,
    '--- 片段结束 ---',
    '',
    '请只输出上述 JSON。',
  ].filter((line) => line !== '').join('\n')
  return { system, user }
}

/**
 * Concrete "if we pick X, this is what happens" illustrations. Kept in its own
 * request so the user pays for examples only when they ask for them.
 */
export function buildExamplesPrompt({ item, excerpt, sourcePath, decided = [] }) {
  const system = [
    '你是决策分析助手。用户已经理解了某个决策点，现在只想看具体例子：选了某个方案、或迟迟不决定，现实中到底会发生什么。',
    '给出 2–3 个例子，每个用「如果……就……」写清楚，要落在文档描述的系统、流程或角色上。',
    '只输出 JSON：',
    '{"examples":[{"if":"如果选 A / 不决定 / 只完成一半","then":"具体会发生什么（不超过120字）"}],"note":"可选：一句话提醒"}',
    '不要引入文档没有的事实；信息不足时给出保守的例子，并在 note 里写明这是假设。',
  ].join('\n')
  const optionText = item.options.length > 0
    ? item.options.map((option) => `- ${option.label}${option.tradeoff ? `：${option.tradeoff}` : ''}`).join('\n')
    : '（文档没有给出备选方案）'
  const prior = decidedLines(decided)
  const user = [
    `文档路径：${sourcePath}`,
    `决策标题：${item.title}`,
    `需要决定的问题：${item.question}`,
    `已有的备选方案：\n${optionText}`,
    prior.length > 0 ? `\n同一份文档中已经做出的决定（保持一致）：\n${prior.join('\n')}` : '',
    '',
    '相关文档片段：',
    '--- 片段开始 ---',
    excerpt,
    '--- 片段结束 ---',
    '',
    '请只输出上述 JSON。',
  ].filter((line) => line !== '').join('\n')
  return { system, user }
}

export function buildAskPrompt({ item, excerpt, sourcePath, thread = [], question }) {
  const system = [
    '你是决策分析助手。用户正在逐题过一份项目文档，并针对一个决策点向你提问。',
    '用中文回答：先给结论，再给依据；引用文档时写「路径:行号」。',
    '不要替用户做决定，只解释利弊、影响和不决策的后果。',
    '回答控制在 350 字以内，纯文本，不要输出 JSON 或 Markdown 代码块。',
  ].join('\n')
  const history = thread
    .filter((message) => message.state === 'ready' && message.text !== '')
    .slice(-6)
    .map((message) => `${message.role === 'user' ? '用户' : '助手'}：${message.text}`)
    .join('\n')
  const optionText = item.options.length > 0
    ? item.options.map((option) => `- ${option.label}${option.tradeoff ? `：${option.tradeoff}` : ''}`).join('\n')
    : '（文档没有给出备选方案）'
  const user = [
    `文档路径：${sourcePath}`,
    `当前讨论的决策：${item.title} —— ${item.question}`,
    item.context ? `背景：${item.context}` : '',
    `已有方案：\n${optionText}`,
    item.decision ? `用户目前的选择：${decisionText(item)}` : '用户还没有做出选择。',
    '',
    '相关文档片段：',
    '--- 片段开始 ---',
    excerpt,
    '--- 片段结束 ---',
    history !== '' ? `\n之前的对话：\n${history}` : '',
    '',
    `用户的新问题：${question}`,
  ].filter((line) => line !== '').join('\n')
  return { system, user }
}

// --- digest ------------------------------------------------------------------

export function decisionText(item) {
  if (!item || typeof item !== 'object') return ''
  const decision = item.decision
  if (!decision || typeof decision !== 'object') return ''
  const labels = []
  for (const id of Array.isArray(decision.optionIds) ? decision.optionIds : []) {
    const option = (Array.isArray(item.options) ? item.options : []).find((entry) => entry.id === id)
    if (option) labels.push(option.label)
  }
  const parts = []
  if (labels.length > 0) parts.push(labels.join('、'))
  if (typeof decision.custom === 'string' && decision.custom.trim() !== '') {
    parts.push(labels.length > 0 ? `自定义补充：${decision.custom.trim()}` : `自定义：${decision.custom.trim()}`)
  }
  return parts.join('；')
}

export function countDecisions(items = []) {
  const stats = { total: items.length, decided: 0, unsure: 0, deferred: 0, unseen: 0, blockingLeft: 0 }
  for (const item of items) {
    if (item.status === 'decided') stats.decided += 1
    else if (item.status === 'unsure') stats.unsure += 1
    else if (item.status === 'deferred') stats.deferred += 1
    else stats.unseen += 1
    if (item.priority === 'blocking' && item.status !== 'decided') stats.blockingLeft += 1
  }
  return stats
}

export function buildDigest(workbench) {
  const items = Array.isArray(workbench.items) ? workbench.items : []
  const stats = countDecisions(items)
  const sourcePath = workbench.source && workbench.source.path ? workbench.source.path : '（未知文档）'
  const lines = []

  lines.push('[决策工作台] 决定摘要')
  lines.push(`文档：${sourcePath}`)
  if (workbench.title) lines.push(`文档标题：${workbench.title}`)
  lines.push(`工作台：${workbench.id}`)
  if (workbench.source && workbench.source.stale) {
    lines.push('> 注意：来源文档在该工作台打开后发生过变化，个别出处可能需要复核。')
  }
  lines.push(
    `统计：已决定 ${stats.decided} / 拿不准 ${stats.unsure} / 稍后 ${stats.deferred} / 未处理 ${stats.unseen}`,
  )
  lines.push('')

  const groups = [
    { status: 'decided', title: `## 已决定（${stats.decided} 项）` },
    { status: 'unsure', title: `## 拿不准（${stats.unsure} 项）` },
    { status: 'deferred', title: `## 稍后再定（${stats.deferred} 项）` },
    { status: 'unseen', title: `## 未处理（${stats.unseen} 项）` },
  ]

  let index = 0
  for (const group of groups) {
    const groupItems = items.filter((item) => item.status === group.status)
    if (groupItems.length === 0) continue
    lines.push(group.title)
    for (const item of groupItems) {
      index += 1
      const location = item.source
        ? `${item.source.path}${item.source.line ? `:${item.source.line}` : ''}`
        : sourcePath
      lines.push(`${index}. ${item.title}`)
      if (item.status === 'decided') {
        lines.push(`   - 选择：${decisionText(item) || '（未记录）'}`)
      } else if (item.status === 'unsure') {
        lines.push('   - 状态：用户拿不准，尚未做出选择')
      } else if (item.status === 'deferred') {
        lines.push('   - 状态：用户选择稍后再定')
      } else {
        lines.push('   - 状态：尚未处理')
      }
      const rationale = (item.decision && item.decision.rationale) || item.rationale
      if (rationale) lines.push(`   - 理由：${rationale}`)
      lines.push(`   - 出处：${location}`)
    }
    lines.push('')
  }

  lines.push('---')
  lines.push('以上「已决定」是用户在工作台中的明确选择。')
  lines.push('「拿不准」「稍后再定」「未处理」的项不得由你自行猜测或代替用户决定；后续工作如果依赖这些项，请先向用户确认。')
  return lines.join('\n')
}

// --- session hand-off --------------------------------------------------------

/** The command result shown in the composer after `/decision` runs. */
export function buildCommandHint({ locale = 'en', mode = 'pick', path = '' } = {}) {
  const isZh = String(locale ?? '').toLowerCase().startsWith('zh')
  if (mode === 'file') {
    return isZh ? `正在打开决策工作台：${path}` : `Opening Decision Workbench: ${path}`
  }
  return isZh
    ? '决策工作台已打开。在右侧选择一份文档开始，或输入 /decision <文件名> 直接开始。'
    : 'Decision Workbench opened. Choose a document in the right sidebar, or run /decision <filename> to start directly.'
}

/**
 * Sent when a workbench starts. The main session must keep its hands off the
 * project until the workbench produces its resolution file: the user is still
 * making the decisions in the sidebar.
 */
export function buildStartNotice({ sourcePath, locale = 'en' }) {
  if (String(locale ?? '').toLowerCase().startsWith('zh')) {
    return [
      '[决策工作台] 工作开始',
      `输入文件：${sourcePath || '（未知文档）'}`,
      '用户正在右侧工作台逐项做决定，结果尚未生成。',
      '请只回复“收到，等待结果”。不要读取、修改或执行任何文件，也不要开始实施或制定计划；等待用户下一步指令。',
    ].join('\n')
  }
  return [
    '[Decision Workbench] Work started',
    `Input file: ${sourcePath || '(unknown document)'}`,
    'The user is making decisions item by item in the right-hand workbench; no result has been generated yet.',
    'Please reply only "Received, waiting for the result". Do not read, modify, or execute any files, and do not start implementing or planning; wait for the user\'s next instruction.',
  ].join('\n')
}

/**
 * Sent when the workbench has written its resolution file. By default the
 * session is told not to read it yet; "autoRead" flips that one instruction
 * while still forbidding implementation work.
 */
export function buildFinishNotice({ sourcePath, resolutionPath, stats = {}, autoRead = false, locale = 'en' }) {
  if (String(locale ?? '').toLowerCase().startsWith('zh')) {
    return [
      '[决策工作台] 工作完成',
      `输入文件：${sourcePath || '（未知文档）'}`,
      `结果文件：${resolutionPath || '（未写入）'}`,
      `统计：已决定 ${stats.decided || 0} / 拿不准 ${stats.unsure || 0} / 稍后 ${stats.deferred || 0} / 未处理 ${stats.unseen || 0}`,
      autoRead
        ? '请读取结果文件，然后只回复“收到”。不要开始执行、修改文件或制定计划；等待用户下一步指令。'
        : '请只回复“收到”。不要读取结果文件，也不要开始执行、修改文件或制定计划；等待用户下一步指令。',
    ].join('\n')
  }
  return [
    '[Decision Workbench] Work completed',
    `Input file: ${sourcePath || '(unknown document)'}`,
    `Result file: ${resolutionPath || '(not written)'}`,
    `Stats: decided ${stats.decided || 0} / unsure ${stats.unsure || 0} / deferred ${stats.deferred || 0} / untouched ${stats.unseen || 0}`,
    autoRead
      ? 'Please read the result file, then reply only "Received". Do not start executing, modify files, or make plans; wait for the user\'s next instruction.'
      : 'Please reply only "Received". Do not read the result file, and do not start executing, modify files, or make plans; wait for the user\'s next instruction.',
  ].join('\n')
}

/**
 * Wrap notice text in the complete user message `agent.followup` expects.
 *
 * The agent stores the object it receives as the session's user message, and
 * both the session log and the provider request require `role` (and the
 * provider rejects the whole request when it is missing). Passing only
 * `content`/`source` therefore poisons the transcript: that turn fails with
 * "missing field `role`" and so does every later turn. Callers supply a fresh
 * id so the same notice is never recorded twice as one message.
 */
export function buildAgentNotice(text, id) {
  return {
    role: 'user',
    id,
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * The durable output of a workbench: a self-contained Markdown decision record
 * next to the project's other decision documents. The workbench itself is
 * removed after this file is written.
 */
export function buildResolution(workbench, options = {}) {
  const record = workbench && typeof workbench === 'object' ? workbench : { items: [] }
  const sourcePath = record.source && record.source.path ? record.source.path : '（未知文档）'
  const title = record.title || sourcePath
  const lines = [
    `# 决策结果：${title}`,
    '',
    `> 来源：\`${sourcePath}\``,
  ]
  if (options.generatedAt) lines.push(`> 完成时间：${options.generatedAt}`)
  if (record.id) lines.push(`> 工作台：${record.id}`)
  lines.push('', buildDigest(record), '')
  return lines.join('\n')
}

// --- misc --------------------------------------------------------------------

export function countByStatus(items = []) {
  return countDecisions(items)
}

export function slugify(text, fallback = 'decisions') {
  const cleaned = String(text ?? '')
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return cleaned === '' ? fallback : cleaned
}
