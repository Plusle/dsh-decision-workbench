// dsh-decision-workbench - host half.
//
// Responsibilities:
//
//   * register the `/decision` command;
//   * answer the browser half's loopback-only JSON routes;
//   * resolve a filename argument against the session workspace and list
//     candidate documents for the panel's file picker;
//   * turn a document into decision items with the configured default model,
//     in an isolated analysis context (no main-conversation history);
//   * lazily explain one item, propose options when the spec has none, and
//     answer per-question follow-ups;
//   * build the decision digest and inject it back into the main session;
//   * keep workbenches across panel close / page reload / Harness restart.
//
// The module imports nothing from the DSH SDK: `commands`, `webServer`, `llm`,
// `agents` and `agentDefaultModel` are resolved through the Cordis context, so
// the plugin loads on any profile that has them and degrades to a clear route
// error when one is absent.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  COMMAND_NAME,
  MAX_DOCUMENT_CHARS,
  MAX_OPTIONS,
  MAX_QUESTION_CHARS,
  PLUGIN_ID,
  ROUTE_PREFIX,
  buildAskPrompt,
  buildDigest,
  buildEnumerationPrompt,
  buildExplanationPrompt,
  buildOptionsPrompt,
  clampText,
  countDecisions,
  isDocumentPath,
  isPathInside,
  normalizeAskText,
  normalizeDecisionPayload,
  normalizeExplanationPayload,
  normalizeOptionsPayload,
  parseDecisionInput,
  parseJsonPayload,
  pickExcerpt,
  slugify,
  toPosixPath,
  truncateDocument,
} from './shared.js'

// How long an unacknowledged open request stays valid. The panel polls every
// second, so this only protects against a request that arrives while no client
// is attached (for example, a command run from a second window).
const PENDING_TTL_MS = 60_000
const FILE_LIST_LIMIT = 200
const FILE_SCAN_DEPTH = 6
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.cache'])
const BODY_LIMIT_BYTES = 64 * 1024
const MODEL_TIMEOUT_MS = 180_000
const STORAGE_LIMIT = 16

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

// --- HTTP helpers -------------------------------------------------------------

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(body)
}

function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT_BYTES) {
        rejectBody(new HttpError(413, 'too-large', 'request body is too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    request.on('error', rejectBody)
  })
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Same-origin, loopback-only guard. The routes only serve the local Harness
 * page; a browser tab on another site must never be able to drive a workbench.
 */
function guard(request, response) {
  if (!isLoopback(request.socket?.remoteAddress)) {
    sendJson(response, 403, { ok: false, code: 'forbidden', error: 'loopback requests only' })
    return false
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    sendJson(response, 403, { ok: false, code: 'forbidden', error: 'cross-site requests are rejected' })
    return false
  }
  const origin = request.headers.origin
  if (typeof origin === 'string' && origin !== '') {
    try {
      if (new URL(origin).host !== request.headers.host) {
        sendJson(response, 403, { ok: false, code: 'forbidden', error: 'origin does not match host' })
        return false
      }
    } catch {
      sendJson(response, 403, { ok: false, code: 'forbidden', error: 'malformed origin' })
      return false
    }
  }
  return true
}

function sessionIdFromQuery(url) {
  try {
    return new URL(url, 'http://127.0.0.1').searchParams.get('sessionId') ?? ''
  } catch {
    return ''
  }
}

function requireSessionId(value) {
  const sessionId = String(value ?? '').trim()
  if (sessionId === '') throw new HttpError(400, 'invalid', 'sessionId is required')
  return sessionId
}

// --- Session and workspace ----------------------------------------------------

function sessionOf(agent) {
  return agent && typeof agent === 'object' ? agent.session : undefined
}

function sessionIdOf(agent) {
  const id = agent?.id ?? sessionOf(agent)?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

// --- Document resolution ------------------------------------------------------

async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Find a document by basename when the exact relative path misses, so
 * `/decision payment-spec.md` works without spelling the whole directory.
 * Returns at most 5 candidates; a handful of hits is enough to disambiguate.
 */
async function searchByBasename(root, name) {
  const wanted = basename(name).toLowerCase()
  const hits = []

  async function walk(directory, depth) {
    if (hits.length >= 5 || depth > FILE_SCAN_DEPTH) return
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (hits.length >= 5) return
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue
        await walk(join(directory, entry.name), depth + 1)
      } else if (entry.isFile() && entry.name.toLowerCase() === wanted) {
        hits.push(join(directory, entry.name))
      }
    }
  }

  await walk(root, 0)
  return hits
}

async function resolveDocument(root, rawArg) {
  const cleaned = String(rawArg ?? '').trim().replace(/^\.\//, '')
  if (cleaned === '') throw new HttpError(400, 'invalid', '文件名不能为空。')

  const absolute = isAbsolute(cleaned) ? resolve(cleaned) : resolve(root, cleaned)
  if (!isPathInside(root, absolute)) {
    throw new HttpError(400, 'outside-workspace', '这个文件不在当前工作区内。')
  }
  if (await isFile(absolute)) {
    if (!isDocumentPath(absolute)) {
      throw new HttpError(415, 'unsupported', `暂不支持 ${extname(absolute) || '这种'} 格式，先试试 .md / .txt / .json / .yaml。`)
    }
    return { abs: absolute, rel: toPosixPath(relative(root, absolute)) }
  }

  const hits = await searchByBasename(root, cleaned)
  if (hits.length === 1) {
    const hit = hits[0]
    if (!isDocumentPath(hit)) {
      throw new HttpError(415, 'unsupported', `暂不支持 ${extname(hit) || '这种'} 格式，先试试 .md / .txt / .json / .yaml。`)
    }
    return { abs: hit, rel: toPosixPath(relative(root, hit)) }
  }
  if (hits.length > 1) {
    const names = hits.map((hit) => toPosixPath(relative(root, hit))).join('、')
    throw new HttpError(409, 'ambiguous', `找到多个同名文件：${names}。请写相对路径再试一次。`)
  }
  throw new HttpError(404, 'not-found', `没找到“${cleaned}”。可以运行 /decision 打开面板选择，或检查文件名。`)
}

async function listDocuments(root, query) {
  const needle = String(query ?? '').trim().toLowerCase()
  const files = []

  async function walk(directory, depth) {
    if (files.length >= FILE_LIST_LIMIT || depth > FILE_SCAN_DEPTH) return
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= FILE_LIST_LIMIT) return
      if (entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue
        await walk(path, depth + 1)
        continue
      }
      if (!entry.isFile() || !isDocumentPath(entry.name)) continue
      const rel = toPosixPath(relative(root, path))
      if (needle !== '' && !rel.toLowerCase().includes(needle)) continue
      let info
      try {
        info = await stat(path)
      } catch {
        continue
      }
      files.push({
        path: rel,
        name: entry.name,
        dir: toPosixPath(dirname(rel)) === '.' ? '' : toPosixPath(dirname(rel)),
        size: info.size,
        mtime: info.mtimeMs,
      })
      if (files.length >= FILE_LIST_LIMIT) return
    }
  }

  await walk(root, 0)
  files.sort((left, right) => right.mtime - left.mtime)
  return files
}

function hashText(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

function storageFile() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'storages', PLUGIN_ID, 'workbenches.json')
}

function describeError(error) {
  if (error instanceof HttpError) return error.message
  const message = String((error && error.message) || error || '').trim()
  return message === '' ? '操作失败，请重试。' : message
}

// --- Plugin -------------------------------------------------------------------

export const inject = ['commands']

export function apply(ctx) {
  /** sessionId -> { requestId, mode: 'pick' | 'workbench', workbenchId?, createdAt } */
  const pending = new Map()
  /** workbenchId -> workbench record */
  const workbenches = new Map()
  /** sessionId -> workbenchId of the most recently opened (or restored) workbench */
  const activeBySession = new Map()
  /** `${workbenchId}:${itemId}:${kind}` while one generation runs */
  const inFlight = new Set()
  /** AbortControllers of live model calls */
  const controllers = new Set()
  /** workbenchId -> { text, hash } */
  const documentCache = new Map()

  const storeFile = storageFile()
  let storeLoaded = false
  let saveTimer = null
  let saveChain = Promise.resolve()

  // --- workspace --------------------------------------------------------------

  function agentOf(sessionId) {
    const agents = ctx.get('agents')
    return agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
  }

  function workspaceOf(agent) {
    const direct = sessionOf(agent)?.header?.cwd
    if (typeof direct === 'string' && direct !== '') return direct
    try {
      const resolved = ctx.get('workingDirectory')?.get?.(sessionOf(agent))
      if (typeof resolved === 'string' && resolved !== '') return resolved
    } catch {
      // fall through
    }
    return undefined
  }

  // --- persistence ------------------------------------------------------------

  async function ensureLoaded() {
    if (storeLoaded) return
    storeLoaded = true
    let parsed
    try {
      parsed = JSON.parse(await readFile(storeFile, 'utf8'))
    } catch {
      return
    }
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.workbenches) ? parsed.workbenches : []
    for (const record of list) {
      if (!record || typeof record !== 'object' || typeof record.id !== 'string') continue
      if (!Array.isArray(record.items)) continue
      workbenches.set(record.id, record)
      if (typeof record.sessionId === 'string') {
        const currentId = activeBySession.get(record.sessionId)
        const current = currentId === undefined ? undefined : workbenches.get(currentId)
        if (current === undefined || (record.updatedAt ?? 0) > (current.updatedAt ?? 0)) {
          activeBySession.set(record.sessionId, record.id)
        }
      }
    }
  }

  async function writeStore() {
    const list = [...workbenches.values()]
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      .slice(0, STORAGE_LIMIT)
    const payload = JSON.stringify({ version: 1, workbenches: list }, null, 2)
    try {
      await mkdir(dirname(storeFile), { recursive: true })
      const temporary = `${storeFile}.${process.pid}.tmp`
      await writeFile(temporary, payload, 'utf8')
      await rename(temporary, storeFile)
    } catch {
      // Persistence is best effort: the in-memory workbench stays usable.
    }
  }

  function saveSoon() {
    if (saveTimer !== null) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveChain = saveChain.then(writeStore, writeStore)
    }, 250)
    if (typeof saveTimer.unref === 'function') saveTimer.unref()
  }

  function saveNow() {
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    saveChain = saveChain.then(writeStore, writeStore)
    return saveChain
  }

  // --- pending open requests --------------------------------------------------

  function setPending(sessionId, request) {
    pending.set(sessionId, { requestId: randomUUID(), createdAt: Date.now(), ...request })
  }

  function takePending(sessionId) {
    const request = pending.get(sessionId)
    if (request === undefined) return undefined
    if (Date.now() - request.createdAt > PENDING_TTL_MS) {
      pending.delete(sessionId)
      return undefined
    }
    return request
  }

  function acknowledgePending(sessionId, requestId) {
    const request = pending.get(sessionId)
    if (request !== undefined && (requestId === undefined || request.requestId === requestId)) {
      pending.delete(sessionId)
      return true
    }
    return false
  }

  // --- workbench records ------------------------------------------------------

  function touch(workbench) {
    workbench.updatedAt = Date.now()
    workbench.revision = (typeof workbench.revision === 'number' ? workbench.revision : 0) + 1
  }

  function createWorkbench(sessionId, document) {
    const workbench = {
      id: `dw_${randomUUID()}`,
      sessionId,
      revision: 0,
      status: 'generating',
      title: '',
      source: { kind: 'file', path: document.rel, abs: document.abs },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      items: [],
      error: '',
    }
    workbenches.set(workbench.id, workbench)
    activeBySession.set(sessionId, workbench.id)
    saveSoon()
    return workbench
  }

  function activeWorkbench(sessionId) {
    const id = activeBySession.get(sessionId)
    return id === undefined ? undefined : workbenches.get(id)
  }

  function requireWorkbench(sessionId, workbenchId) {
    let workbench
    if (typeof workbenchId === 'string' && workbenchId !== '') {
      workbench = workbenches.get(workbenchId)
      if (workbench === undefined || workbench.sessionId !== sessionId) {
        throw new HttpError(404, 'workbench-not-found', '这个决策工作台不存在，或不属于当前会话。')
      }
    } else {
      workbench = activeWorkbench(sessionId)
      if (workbench === undefined) throw new HttpError(404, 'workbench-not-found', '当前会话还没有决策工作台。')
    }
    return workbench
  }

  function requireItem(workbench, itemId) {
    const item = workbench.items.find((entry) => entry.id === itemId)
    if (item === undefined) throw new HttpError(404, 'item-not-found', '这一项决策不存在，可能工作台已经更新。')
    return item
  }

  // --- model ------------------------------------------------------------------

  function configuredSelection() {
    const service = ctx.get('agentDefaultModel')
    try {
      const selection = service && typeof service.currentSelection === 'function' ? service.currentSelection() : undefined
      if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') {
        return selection
      }
    } catch {
      // fall through
    }
    return undefined
  }

  async function resolveSelection(llm) {
    const configured = configuredSelection()
    if (configured !== undefined) return configured
    // No configured default: pick the first advertised provider/model so the
    // workbench still works in a profile that only configured an adapter.
    if (llm && typeof llm.listProviders === 'function') {
      let providers = []
      try {
        providers = llm.listProviders()
      } catch {
        providers = []
      }
      for (const provider of providers) {
        if (!provider || typeof provider.id !== 'string') continue
        try {
          const models = await llm.listModels(provider.id)
          const first = Array.isArray(models) ? models[0] : undefined
          if (first && typeof first.id === 'string') return { provider: provider.id, model: first.id }
        } catch {
          // try the next provider
        }
      }
    }
    throw new HttpError(409, 'no-model', '当前 profile 还没有可用的默认模型。请先在设置里选择一个模型，再重新打开决策工作台。')
  }

  async function callModel({ system, user, maxTokens }) {
    const llm = ctx.get('llm')
    if (!llm || typeof llm.stream !== 'function') {
      throw new HttpError(409, 'no-llm', '当前 profile 没有可用的 LLM 服务，无法生成决策。')
    }
    const selection = await resolveSelection(llm)
    const controller = new AbortController()
    controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS)
    try {
      const options = {
        provider: selection.provider,
        model: selection.model,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
        maxTokens,
        signal: controller.signal,
      }
      if (typeof selection.reasoningEffort === 'string' && selection.reasoningEffort !== '') {
        options.reasoningEffort = selection.reasoningEffort
      }
      let text = ''
      let failure = null
      let finishKind = ''
      for await (const chunk of llm.stream(options)) {
        if (!chunk || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        else if (chunk.type === 'finish' && chunk.reason) {
          finishKind = chunk.reason.kind
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') failure = chunk.reason.failure
        }
      }
      if (controller.signal.aborted) throw new Error(`模型请求超过 ${Math.round(MODEL_TIMEOUT_MS / 1000)} 秒没有完成，请重试。`)
      if (failure !== null) {
        const code = failure && failure.code ? `（${failure.code}）` : ''
        throw new Error(`模型请求失败：${(failure && failure.message) || '未知错误'}${code}`)
      }
      if (text.trim() === '') {
        if (finishKind === 'max-tokens') throw new Error('模型达到输出上限仍未给出答案，请重试。')
        throw new Error('模型没有返回任何文本，请重试。')
      }
      return text
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`模型请求超过 ${Math.round(MODEL_TIMEOUT_MS / 1000)} 秒没有完成，请重试。`)
      throw error
    } finally {
      clearTimeout(timer)
      controllers.delete(controller)
    }
  }

  // --- document access --------------------------------------------------------

  async function readDocument(workbench) {
    const cached = documentCache.get(workbench.id)
    if (cached !== undefined) return cached
    let text
    try {
      text = await readFile(workbench.source.abs, 'utf8')
    } catch {
      throw new HttpError(404, 'source-missing', `来源文档已不存在：${workbench.source.path}。请换一份文档重新开始。`)
    }
    const entry = { text, hash: hashText(text) }
    documentCache.set(workbench.id, entry)
    workbench.source.bytes = Buffer.byteLength(text, 'utf8')
    workbench.source.hash = entry.hash
    return entry
  }

  // --- generation -------------------------------------------------------------

  async function generateDecisions(workbench) {
    const key = `${workbench.id}:enumerate`
    if (inFlight.has(key)) return
    inFlight.add(key)
    if (workbench.status !== 'generating') {
      workbench.status = 'generating'
      workbench.error = ''
      touch(workbench)
      saveSoon()
    }
    try {
      const document = await readDocument(workbench)
      const trimmed = truncateDocument(document.text, MAX_DOCUMENT_CHARS)
      const prompt = buildEnumerationPrompt({
        documentText: trimmed.text,
        sourcePath: workbench.source.path,
        truncated: trimmed.truncated,
        totalChars: trimmed.totalChars,
      })
      let raw = await callModel({ ...prompt, maxTokens: 7_000 })
      let parsed
      try {
        parsed = normalizeDecisionPayload(parseJsonPayload(raw), { sourcePath: workbench.source.path })
      } catch (error) {
        const repair = `${prompt.user}\n\n提醒：上一次输出无法解析为 JSON（${describeError(error)}）。这次只输出一个合法的 JSON 对象，不要输出任何其他文字。`
        raw = await callModel({ system: prompt.system, user: repair, maxTokens: 7_000 })
        parsed = normalizeDecisionPayload(parseJsonPayload(raw), { sourcePath: workbench.source.path })
      }
      workbench.title = parsed.title || workbench.title || ''
      workbench.items = parsed.items
      workbench.status = 'ready'
      workbench.error = ''
      workbench.generatedAt = Date.now()
    } catch (error) {
      workbench.status = 'failed'
      workbench.error = describeError(error)
    } finally {
      inFlight.delete(key)
      touch(workbench)
      saveSoon()
    }
  }

  async function explainItem(workbench, item, force = false) {
    if (!force && item.explanationState === 'ready') return
    const key = `${workbench.id}:${item.id}:explain`
    if (inFlight.has(key)) return
    inFlight.add(key)
    item.explanationState = 'loading'
    item.explanationError = ''
    if (force) item.explanation = undefined
    touch(workbench)
    saveSoon()
    try {
      const document = await readDocument(workbench)
      const excerpt = pickExcerpt(document.text, item.source)
      const prompt = buildExplanationPrompt({
        item,
        excerpt,
        sourcePath: workbench.source.path,
        decided: workbench.items,
      })
      const raw = await callModel({ ...prompt, maxTokens: 6_000 })
      item.explanation = normalizeExplanationPayload(parseJsonPayload(raw), {
        path: workbench.source.path,
        gist: item.context,
      })
      item.explanationState = 'ready'
      item.explanationError = ''
    } catch (error) {
      item.explanationState = 'error'
      item.explanationError = describeError(error)
    } finally {
      inFlight.delete(key)
      touch(workbench)
      saveSoon()
    }
  }

  async function proposeOptions(workbench, item, force = false) {
    if (!force && item.options.length > 0) return
    const key = `${workbench.id}:${item.id}:options`
    if (inFlight.has(key)) return
    inFlight.add(key)
    item.optionsState = 'loading'
    item.optionsError = ''
    touch(workbench)
    saveSoon()
    try {
      const document = await readDocument(workbench)
      const excerpt = pickExcerpt(document.text, item.source)
      const prompt = buildOptionsPrompt({ item, excerpt, sourcePath: workbench.source.path })
      const raw = await callModel({ ...prompt, maxTokens: 4_000 })
      const normalized = normalizeOptionsPayload(parseJsonPayload(raw), { origin: 'assistant' })
      const options = normalized.options.slice(0, MAX_OPTIONS)
      if (options.length === 0) throw new Error('模型没有给出可用的备选方案，请重试或自己写一个。')
      item.options = options
      item.optionsOrigin = 'generated'
      item.recommendation = normalized.recommendation
      item.optionsState = 'ready'
      item.optionsError = ''
    } catch (error) {
      item.optionsState = 'error'
      item.optionsError = describeError(error)
    } finally {
      inFlight.delete(key)
      touch(workbench)
      saveSoon()
    }
  }

  async function answerQuestion(workbench, item, text) {
    const question = clampText(text, MAX_QUESTION_CHARS)
    if (question === '') throw new HttpError(400, 'empty-question', '请先写下你的问题。')
    const key = `${workbench.id}:${item.id}:ask`
    if (inFlight.has(key)) throw new HttpError(409, 'busy', '上一轮回答还在生成，请稍等。')
    inFlight.add(key)
    const userMessage = {
      id: `m_${randomUUID()}`,
      role: 'user',
      text: question,
      at: Date.now(),
      state: 'ready',
    }
    const assistantMessage = {
      id: `m_${randomUUID()}`,
      role: 'assistant',
      text: '',
      at: Date.now(),
      state: 'pending',
    }
    item.thread.push(userMessage, assistantMessage)
    item.threadState = 'loading'
    item.threadError = ''
    touch(workbench)
    saveSoon()

    try {
      const document = await readDocument(workbench)
      const excerpt = pickExcerpt(document.text, item.source)
      const prompt = buildAskPrompt({
        item,
        excerpt,
        sourcePath: workbench.source.path,
        thread: item.thread,
        question,
      })
      const raw = await callModel({ ...prompt, maxTokens: 2_500 })
      const answer = normalizeAskText(raw)
      if (answer === '') throw new Error('助手没有返回内容，请重试。')
      assistantMessage.text = answer
      assistantMessage.state = 'ready'
      item.threadState = 'idle'
    } catch (error) {
      assistantMessage.state = 'error'
      assistantMessage.text = describeError(error)
      item.threadState = 'error'
      item.threadError = describeError(error)
    } finally {
      inFlight.delete(key)
      touch(workbench)
      saveSoon()
    }
  }

  // --- starting a workbench ---------------------------------------------------

  async function startFromDocument(sessionId, document, restart = false) {
    const existing = activeWorkbench(sessionId)
    if (!restart && existing !== undefined && existing.source.abs === document.abs && existing.status !== 'failed') {
      return existing
    }
    const workbench = createWorkbench(sessionId, document)
    void generateDecisions(workbench)
    return workbench
  }

  // --- routes -----------------------------------------------------------------

  const registerRoutes = (webServer, fiber) => {
    const route = (path, methods, handle) => {
      fiber.effect(() =>
        webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}${path}`,
          handler: async (request, response) => {
            if (!guard(request, response)) return
            if (!methods.includes(request.method)) {
              sendJson(response, 405, { ok: false, code: 'method', error: `${methods.join(' / ')} only` })
              return
            }
            try {
              await handle(request, response)
            } catch (error) {
              const status = error instanceof HttpError ? error.status : 500
              const code = error instanceof HttpError ? error.code : 'internal'
              sendJson(response, status, {
                ok: false,
                code,
                error: describeError(error),
              })
            }
          },
        }),
      )
    }

    route('/pending', ['GET'], async (request, response) => {
      const sessionId = requireSessionId(sessionIdFromQuery(request.url))
      sendJson(response, 200, { ok: true, pending: takePending(sessionId) ?? null })
    })

    route('/pending/ack', ['POST'], async (request, response) => {
      const body = JSON.parse((await readBody(request)) || '{}')
      const sessionId = requireSessionId(body.sessionId)
      const cleared = acknowledgePending(sessionId, body.requestId)
      sendJson(response, 200, { ok: true, cleared })
    })

    route('/files', ['GET'], async (request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1')
      const sessionId = requireSessionId(url.searchParams.get('sessionId'))
      const query = url.searchParams.get('query') ?? ''
      const agent = agentOf(sessionId)
      const root = workspaceOf(agent)
      if (root === undefined) {
        throw new HttpError(409, 'no-workspace', '当前会话还没有工作区，先打开一个工作区再选择文件。')
      }
      sendJson(response, 200, { ok: true, root: toPosixPath(root), files: await listDocuments(root, query) })
    })

    route('/start', ['POST'], async (request, response) => {
      await ensureLoaded()
      const body = JSON.parse((await readBody(request)) || '{}')
      const sessionId = requireSessionId(body.sessionId)
      const agent = agentOf(sessionId)
      const root = workspaceOf(agent)
      if (root === undefined) {
        throw new HttpError(409, 'no-workspace', '当前会话还没有工作区，先打开一个工作区再开始。')
      }
      if (typeof body.path !== 'string' || body.path.trim() === '') {
        throw new HttpError(400, 'invalid', '请选择一份文档。')
      }
      const document = await resolveDocument(root, body.path)
      const workbench = await startFromDocument(sessionId, document, body.restart === true)
      sendJson(response, 200, { ok: true, workbench })
    })

    route('/workbench', ['GET'], async (request, response) => {
      await ensureLoaded()
      const sessionId = requireSessionId(sessionIdFromQuery(request.url))
      sendJson(response, 200, { ok: true, workbench: activeWorkbench(sessionId) ?? null })
    })

    route('/item', ['POST'], async (request, response) => {
      await ensureLoaded()
      const body = JSON.parse((await readBody(request)) || '{}')
      const sessionId = requireSessionId(body.sessionId)
      const workbench = requireWorkbench(sessionId, body.workbenchId)
      const item = requireItem(workbench, body.itemId)
      item.lastViewedAt = Date.now()
      sendJson(response, 200, { ok: true, item })
    })

    route('/explain', ['POST'], async (request, response) => {
      await ensureLoaded()
      const body = JSON.parse((await readBody(request)) || '{}')
      const sessionId = requireSessionId(body.sessionId)
      const workbench = requireWorkbench(sessionId, body.workbenchId)
      const item = requireItem(workbench, body.itemId)
      void explainItem(workbench, item, body.force === true)
      sendJson(response, 200, { ok: true, item })
    })

    route('/options', ['POST'], async (request, response) => {
      await ensureLoaded()
      const body = JSON.parse((await readBody(request)) || '{}')
      const sessionId = requireSessionId(body.sessionId)
      const workbench = requireWorkbench(sessionId, body.workbenchId)
      const item = requireItem(workbench, body.itemId)
      void proposeOptions(workbench, item, body.force === true)
      sendJson(response, 200, { ok: true, item })
    })

    route('/ask', ['POST'], async (request, response) => {
      await ensureLoaded()
      const body = JSON.parse((await readBody(request)) || '{}')
      const sessionId = requireSessionId(body.sessionId)
      const workbench = requireWorkbench(sessionId, body.workbenchId)
      const item = requireItem(workbench, body.itemId)
      if (typeof body.text !== 'string' || body.text.trim() === '') {
        throw new HttpError(400, 'invalid', '请先写下你的问题。')
      }
      void answerQuestion(workbench, item, body.text)
      sendJson(response, 200, { ok: true, item })
    })

    route('/decide', ['POST'], async (request, response) => {
      await ensureLoaded()
      const body = JSON.parse((await readBody(request)) || '{}')
      const sessionId = requireSessionId(body.sessionId)
      const workbench = requireWorkbench(sessionId, body.workbenchId)
      const item = requireItem(workbench, body.itemId)
      const status = typeof body.status === 'string' ? body.status : ''
      if (!['decided', 'unsure', 'deferred', 'unseen'].includes(status)) {
        throw new HttpError(400, 'invalid', 'status 只能是 decided / unsure / deferred / unseen。')
      }

      if (status === 'decided') {
        const optionIds = Array.isArray(body.optionIds)
          ? body.optionIds.filter((id) => typeof id === 'string' && item.options.some((option) => option.id === id))
          : []
        const custom = clampText(body.custom, 500)
        const rationale = clampText(body.rationale, 1_000)
        if (optionIds.length === 0 && custom === '') {
          throw new HttpError(400, 'no-choice', '请选择一个方案，或写下你的自定义方案。')
        }
        item.status = 'decided'
        item.decision = { optionIds, custom, rationale, at: Date.now() }
      } else if (status === 'unseen') {
        item.status = 'unseen'
        delete item.decision
      } else {
        item.status = status
        item.decision = {
          optionIds: [],
          custom: '',
          rationale: clampText(body.rationale, 1_000),
          at: Date.now(),
        }
      }
      touch(workbench)
      await saveNow()
      sendJson(response, 200, { ok: true, item, stats: countDecisions(workbench.items) })
    })

    route('/preview', ['POST'], async (request, response) => {
      await ensureLoaded()
      const body = JSON.parse((await readBody(request)) || '{}')
      const sessionId = requireSessionId(body.sessionId)
      const workbench = requireWorkbench(sessionId, body.workbenchId)
      sendJson(response, 200, {
        ok: true,
        digest: buildDigest(workbench),
        stats: countDecisions(workbench.items),
        source: workbench.source,
      })
    })

    route('/submit', ['POST'], async (request, response) => {
      await ensureLoaded()
      const body = JSON.parse((await readBody(request)) || '{}')
      const sessionId = requireSessionId(body.sessionId)
      const workbench = requireWorkbench(sessionId, body.workbenchId)
      const digest = buildDigest(workbench)
      const agent = agentOf(sessionId)
      if (agent === undefined || typeof agent.followup !== 'function') {
        throw new HttpError(409, 'no-agent', '主会话当前不在运行，无法回写摘要。摘要已经生成，可以先复制保存。')
      }
      try {
        await agent.followup({
          content: [{ type: 'text', text: digest }],
          source: { kind: 'user' },
        })
      } catch (error) {
        throw new HttpError(500, 'delivery-failed', `摘要回写主会话失败：${describeError(error)}`)
      }
      workbench.status = 'submitted'
      workbench.submittedAt = Date.now()
      workbench.digest = digest
      touch(workbench)
      await saveNow()
      sendJson(response, 200, { ok: true, workbench, digest, stats: countDecisions(workbench.items) })
    })

    route('/write', ['POST'], async (request, response) => {
      await ensureLoaded()
      const body = JSON.parse((await readBody(request)) || '{}')
      const sessionId = requireSessionId(body.sessionId)
      const workbench = requireWorkbench(sessionId, body.workbenchId)
      const agent = agentOf(sessionId)
      const root = workspaceOf(agent) ?? dirname(workbench.source.abs)
      const targetDirectory = join(root, 'docs', 'decisions')
      if (!isPathInside(root, targetDirectory)) {
        throw new HttpError(400, 'outside-workspace', '决策记录目录不在当前工作区内。')
      }
      const digest = buildDigest(workbench)
      const date = new Date().toLocaleDateString('sv-SE')
      const title = workbench.title || basename(workbench.source.path, extname(workbench.source.path))
      const slug = slugify(title)
      await mkdir(targetDirectory, { recursive: true })
      let target = join(targetDirectory, `${date}-${slug}.md`)
      for (let attempt = 2; attempt < 20; attempt += 1) {
        if (!(await isFile(target))) break
        target = join(targetDirectory, `${date}-${slug}-${attempt}.md`)
      }
      const content = [
        `# 决策记录：${title}`,
        '',
        `> 来源：\`${workbench.source.path}\``,
        `> 生成时间：${new Date().toLocaleString('zh-CN')}`,
        `> 工作台：${workbench.id}`,
        '',
        digest,
        '',
      ].join('\n')
      await writeFile(target, content, 'utf8')
      sendJson(response, 200, {
        ok: true,
        path: toPosixPath(relative(root, target)),
        absolute: toPosixPath(target),
      })
    })
  }

  const webServer = ctx.get('webServer')
  if (webServer) {
    registerRoutes(webServer, ctx)
  } else {
    ctx.inject(['webServer'], (sub) => registerRoutes(sub.webServer, sub))
  }

  // --- command ----------------------------------------------------------------

  async function handleDecisionCommand(invocation) {
    const parsed = parseDecisionInput(invocation.rawInput)
    const sessionId = sessionIdOf(invocation.agent)
    if (sessionId === undefined) {
      return { kind: 'error', text: '无法确定当前会话，请重试。' }
    }
    const root = workspaceOf(invocation.agent)
    if (root === undefined) {
      return { kind: 'error', text: '当前会话还没有工作区。先打开一个工作区，再运行 /decision。' }
    }

    await ensureLoaded()

    if (parsed.mode === 'pick') {
      setPending(sessionId, { mode: 'pick' })
      return {
        kind: 'success',
        text: '决策工作台已打开。在右侧选择一份文档开始，或输入 /decision <文件名> 直接开始。',
      }
    }

    try {
      const document = await resolveDocument(root, parsed.arg)
      const workbench = await startFromDocument(sessionId, document)
      setPending(sessionId, { mode: 'workbench', workbenchId: workbench.id })
      return { kind: 'success', text: `正在打开决策工作台：${document.rel}` }
    } catch (error) {
      return { kind: 'error', text: describeError(error) }
    }
  }

  ctx.effect(() =>
    ctx.commands.register({
      name: COMMAND_NAME,
      description: '打开决策工作台：/decision 选择文件，/decision <文件名> 直接开始',
      input: { hint: '[文件名]' },
      handler: handleDecisionCommand,
    }),
  )

  // --- teardown ---------------------------------------------------------------

  ctx.effect(() => () => {
    for (const controller of controllers) {
      try {
        controller.abort()
      } catch {
        // ignore
      }
    }
    controllers.clear()
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    if (workbenches.size > 0) void saveNow()
  })
}
