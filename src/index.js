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
//   * write the decision resolution file and notify the main session;
//   * keep unfinished workbenches across panel close / page reload / restart.
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
  buildAgentNotice,
  buildAskPrompt,
  buildCommandHint,
  buildDigest,
  buildEnumerationPrompt,
  buildExamplesPrompt,
  buildExplanationPrompt,
  buildFinishNotice,
  buildOptionsPrompt,
  buildResolution,
  buildStartNotice,
  clampText,
  countDecisions,
  findStaleItems,
  isDocumentPath,
  isPathInside,
  mergeDuplicateItems,
  normalizeAskText,
  normalizeDecisionPayload,
  normalizeExamplesPayload,
  normalizeExplanationPayload,
  normalizeOptionsPayload,
  normalizeWorkspacePath,
  parseDecisionInput,
  parseJsonPayload,
  pickExcerpt,
  sameWorkspaceRoot,
  slugify,
  toPosixPath,
  truncateDocument,
} from './shared.js'

// How long an unacknowledged open request stays valid. The panel polls every
// second, so this only protects against a request that arrives while no client
// is attached (for example, a command run from a second window).
const PENDING_TTL_MS = 60_000
const FILE_LIST_LIMIT = 60
const FILE_SCAN_DEPTH = 8
const FILE_SCAN_BUDGET_MS = 150
const FILE_INDEX_LIMIT = 4_000
const FILE_INDEX_BUDGET_MS = 300
const FILE_INDEX_TTL_MS = 30_000
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  'target',
  'vendor',
  'obj',
  'bin',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.idea',
  '.vscode',
  'logs',
  'tmp',
  'temp',
])
/** root -> { at, files } so name-only searches do not re-walk the tree per keystroke. */
const fileIndexCache = new Map()
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

// A finished workbench is represented by its resolution file, not by the
// in-memory record. Older versions kept `submitted` records around; they stay
// in the store for audit but are no longer offered as resumable work.
function isOpenWorkbench(record) {
  return Boolean(record) && record.status !== 'submitted'
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

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
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

function documentEntry(rel, name) {
  const directory = toPosixPath(dirname(rel))
  return { path: rel, name, dir: directory === '.' ? '' : directory }
}

async function walkDocumentFiles(startDir, root, options, onFile) {
  const stack = [{ dir: startDir, depth: 0 }]
  let seen = 0
  while (stack.length > 0) {
    if (Date.now() > options.deadline || seen >= options.limit) return
    const current = stack.pop()
    let entries
    try {
      entries = await readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (Date.now() > options.deadline || seen >= options.limit) return
      if (entry.name.startsWith('.')) continue
      const path = join(current.dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name) || current.depth >= options.maxDepth) continue
        stack.push({ dir: path, depth: current.depth + 1 })
        continue
      }
      if (!entry.isFile() || !isDocumentPath(entry.name)) continue
      const rel = toPosixPath(relative(root, path))
      seen += 1
      if (onFile(documentEntry(rel, entry.name)) === false) return
    }
  }
}

function cachedFileIndex(root) {
  const entry = fileIndexCache.get(root)
  if (entry === undefined || Date.now() - entry.at > FILE_INDEX_TTL_MS) return undefined
  return entry.files
}

async function buildFileIndex(root) {
  const files = []
  await walkDocumentFiles(
    root,
    root,
    { maxDepth: FILE_SCAN_DEPTH, deadline: Date.now() + FILE_INDEX_BUDGET_MS, limit: FILE_INDEX_LIMIT },
    (file) => {
      files.push(file)
      return true
    },
  )
  fileIndexCache.set(root, { at: Date.now(), files })
  if (fileIndexCache.size > 8) {
    const oldest = fileIndexCache.keys().next().value
    if (oldest !== undefined) fileIndexCache.delete(oldest)
  }
  return files
}

function matchScore(rel, name, needle) {
  const lower = rel.toLowerCase()
  if (lower === needle) return 0
  if (lower.startsWith(needle)) return 1
  const base = name.toLowerCase()
  if (base === needle || base.startsWith(needle)) return 2
  return 3
}

function orderMatches(files, needle) {
  return files.sort((left, right) => {
    const byScore = matchScore(left.path, left.name, needle) - matchScore(right.path, right.name, needle)
    if (byScore !== 0) return byScore
    if (left.path.length !== right.path.length) return left.path.length - right.path.length
    return left.path.localeCompare(right.path)
  })
}

async function listDocuments(root, query) {
  const needle = String(query ?? '').trim().toLowerCase().replace(/\\/g, '/')
  // An empty query is not a listing request. Walking a large project just to
  // fill the picker is both slow and noisy; the client asks for a relative path.
  if (needle === '') return []

  const slash = needle.lastIndexOf('/')
  if (slash >= 0) {
    const prefix = needle.slice(0, slash)
    const start = prefix === '' ? root : resolve(root, prefix)
    if (isPathInside(root, start) && (await isDirectory(start))) {
      const matches = []
      await walkDocumentFiles(
        start,
        root,
        { maxDepth: FILE_SCAN_DEPTH, deadline: Date.now() + FILE_SCAN_BUDGET_MS, limit: FILE_INDEX_LIMIT },
        (file) => {
          if (!file.path.toLowerCase().includes(needle)) return true
          matches.push(file)
          return matches.length < FILE_LIST_LIMIT
        },
      )
      return orderMatches(matches.slice(0, FILE_LIST_LIMIT), needle)
    }
  }

  const index = cachedFileIndex(root) ?? (await buildFileIndex(root))
  const matches = index.filter((file) => file.path.toLowerCase().includes(needle))
  return orderMatches(matches.slice(0, FILE_LIST_LIMIT), needle)
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
  /**
   * `${sessionId}|${workspaceRoot}` -> workbenchId of the most recently opened
   * (or restored) workbench. A workbench never crosses that pair: the same
   * session pointed at another directory (or another session opening the same
   * document) sees nothing until it starts its own workbench.
   */
  const activeByScope = new Map()
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

  async function resolveWorkspace(agent, signal) {
    const session = sessionOf(agent)
    const workingDirectory = ctx.get('workingDirectory')
    if (workingDirectory) {
      // `workingDirectory` owns the Session's effective directory: the user can
      // switch it after the session started. Read it before the immutable
      // original `header.cwd`, otherwise a switched session keeps scanning its
      // first workspace.
      try {
        const current = workingDirectory.get?.(session)
        if (typeof current === 'string' && current !== '') return current
      } catch {
        // fall through to ensure
      }
      // A fresh session may have no committed cwd yet; `ensure` resolves and
      // commits the deployment default so `/decision` works on a brand-new
      // session instead of failing with "no workspace".
      try {
        if (typeof workingDirectory.ensure === 'function') {
          const ensured = await workingDirectory.ensure(agent, signal)
          if (typeof ensured === 'string' && ensured !== '') return ensured
        }
      } catch {
        // fall through to the original header
      }
    }
    const direct = session?.header?.cwd
    if (typeof direct === 'string' && direct !== '') return direct
    return undefined
  }

  // --- persistence ------------------------------------------------------------

  /** A workbench is addressable only from the session and workspace it was born in. */
  function scopeKey(sessionId, root) {
    return `${sessionId}|${normalizeWorkspacePath(root)}`
  }

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
      if (typeof record.sessionId !== 'string') continue
      // Records written before 0.3.0 carry no workspace binding. They cannot be
      // proven to belong to the current workspace, so they are not restored:
      // exposing them would be exactly the cross-workspace leak this guards.
      if (typeof record.workspaceRoot !== 'string' || record.workspaceRoot === '') continue
      workbenches.set(record.id, record)
      if (!isOpenWorkbench(record)) continue
      const key = scopeKey(record.sessionId, record.workspaceRoot)
      const currentId = activeByScope.get(key)
      const current = currentId === undefined ? undefined : workbenches.get(currentId)
      if (current === undefined || (record.updatedAt ?? 0) > (current.updatedAt ?? 0)) {
        activeByScope.set(key, record.id)
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

  function createWorkbench(sessionId, document, root) {
    const workspaceRoot = normalizeWorkspacePath(root)
    const workbench = {
      id: `dw_${randomUUID()}`,
      sessionId,
      workspaceRoot,
      revision: 0,
      status: 'generating',
      title: '',
      source: { kind: 'file', path: document.rel, abs: document.abs },
      startNotified: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      items: [],
      error: '',
    }
    workbenches.set(workbench.id, workbench)
    activeByScope.set(scopeKey(sessionId, workspaceRoot), workbench.id)
    saveSoon()
    return workbench
  }

  function activeWorkbench(sessionId, root) {
    const id = activeByScope.get(scopeKey(sessionId, root))
    if (id === undefined) return undefined
    const record = workbenches.get(id)
    return isOpenWorkbench(record) ? record : undefined
  }

  /** Every open workbench this session created in this workspace, newest first. */
  function workbenchesForScope(sessionId, root) {
    return [...workbenches.values()]
      .filter(
        (record) =>
          isOpenWorkbench(record) &&
          record.sessionId === sessionId &&
          sameWorkspaceRoot(record.workspaceRoot, root),
      )
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
  }

  function requireWorkbench(sessionId, workbenchId, root) {
    let workbench
    if (typeof workbenchId === 'string' && workbenchId !== '') {
      workbench = workbenches.get(workbenchId)
      if (workbench === undefined) {
        throw new HttpError(404, 'workbench-not-found', '这个决策工作台不存在，可能已经被清理。')
      }
      if (workbench.sessionId !== sessionId) {
        throw new HttpError(404, 'workbench-not-found', '这个决策工作台不属于当前会话。')
      }
      if (!sameWorkspaceRoot(workbench.workspaceRoot, root)) {
        // The session changed its working directory: its own older workbench is
        // still not reachable from here, because a workbench is bound to the
        // workspace it was created in.
        throw new HttpError(404, 'workbench-other-workspace', '这个决策工作台属于另一个工作区，在这里打不开。请用 /decision 在当前工作区重新开始。')
      }
    } else {
      workbench = activeWorkbench(sessionId, root)
      if (workbench === undefined) throw new HttpError(404, 'workbench-not-found', '这个工作区里还没有决策工作台，先用 /decision 打开一个。')
    }
    return workbench
  }

  /** Mutating routes only accept the workbench currently active in this scope. */
  function requireActiveWorkbench(sessionId, workbenchId, root) {
    const workbench = requireWorkbench(sessionId, workbenchId, root)
    const active = activeWorkbench(sessionId, root)
    if (active === undefined || active.id !== workbench.id) {
      throw new HttpError(409, 'read-only', '这是历史工作台，只能查看。点「继续这个工作台」后才能修改。')
    }
    return workbench
  }

  async function requireWorkspace(sessionId) {
    const root = await resolveWorkspace(agentOf(sessionId))
    if (root === undefined || root === '') {
      throw new HttpError(409, 'no-workspace', '当前会话还没有工作区，先打开一个工作区再继续。')
    }
    return root
  }

  /**
   * Send a control message to the main session. The workbench must keep
   * working when the agent is not running, so a missing/failed delivery is a
   * boolean, not an exception.
   */
  async function notifyAgent(sessionId, text) {
    const agent = agentOf(sessionId)
    if (agent === undefined || typeof agent.followup !== 'function') return false
    try {
      // `followup` takes a complete user message, not just content: the session
      // records it verbatim and the provider rejects a request whose message
      // lacks `role`, which would break this turn and every later one.
      await agent.followup(buildAgentNotice(text, randomUUID()))
      return true
    } catch {
      return false
    }
  }

  /** Resolve a notice locale: explicit client id, then the Host locale setting, then DSH's English fallback. */
  function resolveLocale(explicit) {
    const normalize = (value) => {
      const text = String(value ?? '').trim().toLowerCase()
      if (text.startsWith('zh')) return 'zh'
      if (text.startsWith('en')) return 'en'
      return ''
    }
    const direct = normalize(explicit)
    if (direct !== '') return direct
    try {
      const settings = ctx.get('settings')
      const section = settings && typeof settings.get === 'function' ? settings.get('locale') : undefined
      const stored = normalize(section && section.preference)
      if (stored !== '') return stored
    } catch {
      // fall through to the default
    }
    return 'en'
  }

  function localizeCommandError(error, locale, arg) {
    if (locale === 'zh' || !(error instanceof HttpError)) return describeError(error)
    switch (error.code) {
      case 'invalid':
        return 'File name cannot be empty.'
      case 'outside-workspace':
        return 'That file is outside the current workspace.'
      case 'unsupported':
        return 'That file type is not supported. Try .md / .txt / .json / .yaml.'
      case 'ambiguous':
        return `Multiple files match "${arg}". Use a relative path.`
      case 'not-found':
        return `Could not find "${arg}". Run /decision to pick a file, or check the name.`
      default:
        return describeError(error)
    }
  }

  /** Remove a workbench record and, if it was active, hand the slot to the newest open one. */
  function dropWorkbench(workbench) {
    workbenches.delete(workbench.id)
    documentCache.delete(workbench.id)
    const key = scopeKey(workbench.sessionId, workbench.workspaceRoot)
    if (activeByScope.get(key) === workbench.id) {
      activeByScope.delete(key)
      const next = workbenchesForScope(workbench.sessionId, workbench.workspaceRoot)[0]
      if (next !== undefined) activeByScope.set(key, next.id)
    }
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
    let info
    try {
      text = await readFile(workbench.source.abs, 'utf8')
      info = await stat(workbench.source.abs)
    } catch {
      throw new HttpError(404, 'source-missing', `来源文档已不存在：${workbench.source.path}。请换一份文档重新开始。`)
    }
    const entry = { text, hash: hashText(text) }
    documentCache.set(workbench.id, entry)
    workbench.source.bytes = info.size
    workbench.source.mtimeMs = info.mtimeMs
    workbench.source.hash = entry.hash
    workbench.source.stale = false
    workbench.source.missing = false
    return entry
  }

  /**
   * Cheap change detection for every `/workbench` read: one stat, no file read,
   * no model call. A stale flag only surfaces a banner; nothing is invalidated
   * until the user asks for a resync.
   */
  async function refreshSourceState(workbench) {
    const source = workbench.source
    if (!source || typeof source.abs !== 'string' || source.abs === '') return workbench
    try {
      const info = await stat(source.abs)
      source.missing = false
      const known = typeof source.hash === 'string' && source.hash !== ''
      source.stale = known && (info.size !== source.bytes || info.mtimeMs !== source.mtimeMs)
    } catch {
      source.missing = true
    }
    return workbench
  }

  /**
   * Re-read the source and re-check every citation. Decisions are never
   * dropped: an item whose quote disappeared is flagged `sourceStale` for the
   * user to revisit, and untouched items keep their status.
   */
  async function resyncSource(workbench) {
    let text
    let info
    try {
      text = await readFile(workbench.source.abs, 'utf8')
      info = await stat(workbench.source.abs)
    } catch {
      throw new HttpError(404, 'source-missing', `来源文档已不存在：${workbench.source.path}。`)
    }
    const hash = hashText(text)
    const changed = hash !== workbench.source.hash
    documentCache.set(workbench.id, { text, hash })
    workbench.source.hash = hash
    workbench.source.bytes = info.size
    workbench.source.mtimeMs = info.mtimeMs
    workbench.source.stale = false
    workbench.source.missing = false
    workbench.source.resyncedAt = Date.now()
    if (changed) {
      const stale = new Set(findStaleItems(text, workbench.items))
      for (const item of workbench.items) item.sourceStale = stale.has(item.id)
      workbench.sourceInvalidCount = stale.size
    } else {
      for (const item of workbench.items) item.sourceStale = false
      workbench.sourceInvalidCount = 0
    }
    touch(workbench)
    await saveNow()
    return workbench
  }

  // --- resolution file --------------------------------------------------------

  /**
   * Write the durable output of a workbench. The file is the hand-off to the
   * project; the in-memory workbench is deleted after a successful write.
   */
  async function writeResolution(workbench, root) {
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
    const content = buildResolution(workbench, { generatedAt: new Date().toLocaleString('zh-CN') })
    await writeFile(target, content, 'utf8')
    return {
      path: toPosixPath(relative(root, target)),
      absolute: toPosixPath(target),
      digest,
    }
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
      let raw
      try {
        raw = await callModel({ ...prompt, maxTokens: 16_000 })
      } catch (error) {
        if (!/输出上限/.test(describeError(error))) throw error
        // A very large design document can exhaust the output budget while the
        // model is still reasoning. Ask for a shorter, complete JSON instead.
        const shorter = `${prompt.user}\n\n注意：请只列出最重要的 15 个决策点，并务必输出完整、合法的 JSON。`
        raw = await callModel({ system: prompt.system, user: shorter, maxTokens: 12_000 })
      }
      let parsed
      try {
        parsed = normalizeDecisionPayload(parseJsonPayload(raw), { sourcePath: workbench.source.path })
      } catch (error) {
        const repair = `${prompt.user}\n\n提醒：上一次输出无法解析为 JSON（${describeError(error)}）。这次只输出一个合法的 JSON 对象，不要输出任何其他文字。`
        raw = await callModel({ system: prompt.system, user: repair, maxTokens: 12_000 })
        parsed = normalizeDecisionPayload(parseJsonPayload(raw), { sourcePath: workbench.source.path })
      }
      workbench.title = parsed.title || workbench.title || ''
      // Near-duplicate rows are folded here, once, so the user never answers
      // the same question twice under two slightly different titles.
      const merged = mergeDuplicateItems(parsed.items)
      workbench.items = merged.items
      workbench.duplicatesMerged = merged.merged
      workbench.sourceInvalidCount = 0
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
      const raw = await callModel({ ...prompt, maxTokens: 8_000 })
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

  /**
   * Concrete examples are their own request. The panel never calls this on item
   * open: the user presses a button, so a browsing pass costs zero tokens.
   */
  async function generateExamples(workbench, item, force = false) {
    if (!force && item.examplesState === 'ready') return
    const key = `${workbench.id}:${item.id}:examples`
    if (inFlight.has(key)) return
    inFlight.add(key)
    item.examplesState = 'loading'
    item.examplesError = ''
    if (force) item.examples = []
    touch(workbench)
    saveSoon()
    try {
      const document = await readDocument(workbench)
      const excerpt = pickExcerpt(document.text, item.source)
      const prompt = buildExamplesPrompt({
        item,
        excerpt,
        sourcePath: workbench.source.path,
        decided: workbench.items,
      })
      const raw = await callModel({ ...prompt, maxTokens: 3_000 })
      const normalized = normalizeExamplesPayload(parseJsonPayload(raw))
      if (normalized.examples.length === 0) throw new Error('助手没有给出具体例子，请重试。')
      item.examples = normalized.examples
      item.examplesNote = normalized.note
      item.examplesState = 'ready'
      item.examplesError = ''
    } catch (error) {
      item.examplesState = 'error'
      item.examplesError = describeError(error)
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

  async function startFromDocument(sessionId, document, root, restart = false) {
    const existing = activeWorkbench(sessionId, root)
    if (!restart && existing !== undefined && existing.source.abs === document.abs && existing.status !== 'failed') {
      return existing
    }
    const workbench = createWorkbench(sessionId, document, root)
    // The start notice is sent by the panel once it knows the active locale;
    // this keeps the hand-off localized for both `/decision <file>` and the
    // file picker. Generation itself starts immediately.
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
      const pendingRequest = takePending(sessionId)
      if (pendingRequest !== undefined && typeof pendingRequest.workspaceRoot === 'string') {
        const root = await resolveWorkspace(agentOf(sessionId))
        if (root !== undefined && !sameWorkspaceRoot(pendingRequest.workspaceRoot, root)) {
          // The session changed directory after `/decision` ran. Opening that
          // workbench here would show one workspace's data inside another.
          sendJson(response, 200, { ok: true, pending: null, dropped: true })
          return
        }
      }
      sendJson(response, 200, { ok: true, pending: pendingRequest ?? null })
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
      const root = await requireWorkspace(sessionId)
      sendJson(response, 200, { ok: true, root: toPosixPath(root), files: await listDocuments(root, query) })
    })

    route('/start', ['POST'], async (request, response) => {
      await ensureLoaded()
      const body = JSON.parse((await readBody(request)) || '{}')
      const sessionId = requireSessionId(body.sessionId)
      const root = await requireWorkspace(sessionId)
      if (typeof body.path !== 'string' || body.path.trim() === '') {
        throw new HttpError(400, 'invalid', '请选择一份文档。')
      }
      const document = await resolveDocument(root, body.path)
      const workbench = await startFromDocument(sessionId, document, root, body.restart === true)
      await refreshSourceState(workbench)
      sendJson(response, 200, { ok: true, workbench })
    })

    // The panel calls this once it has mounted the workbench, so the start
    // hand-off carries the browser's active locale (the Host has no reliable
    // view of a browser-derived language). The flag makes it idempotent.
    route('/start-notice', ['POST'], async (request, response) => {
      await ensureLoaded()
      const body = JSON.parse((await readBody(request)) || '{}')
      const sessionId = requireSessionId(body.sessionId)
      const root = await requireWorkspace(sessionId)
      const workbench = requireActiveWorkbench(sessionId, body.workbenchId, root)
      if (workbench.startNotified === true) {
        sendJson(response, 200, { ok: true, notified: true, already: true })
        return
      }
      const locale = resolveLocale(body.locale)
      const notified = await notifyAgent(
        sessionId,
        buildStartNotice({ sourcePath: workbench.source.path, locale }),
      )
      if (notified) {
        workbench.startNotified = true
        touch(workbench)
        await saveNow()
      }
      sendJson(response, 200, { ok: true, notified, already: false, locale })
    })

    route('/workbench', ['GET'], async (request, response) => {
      await ensureLoaded()
      const url = new URL(request.url, 'http://127.0.0.1')
      const sessionId = requireSessionId(url.searchParams.get('sessionId'))
      const workbenchId = url.searchParams.get('workbenchId') ?? ''
      const root = await requireWorkspace(sessionId)
      const active = activeWorkbench(sessionId, root)
      // Without an explicit id this answers "what is open here"; with one it
      // also serves history browsing, still bound to this session+workspace.
      const workbench = workbenchId === '' ? active ?? null : requireWorkbench(sessionId, workbenchId, root)
      if (workbench) await refreshSourceState(workbench)
      sendJson(response, 200, {
        ok: true,
        workbench,
        activeId: active ? active.id : '',
      })
    })

    route('/workbenches', ['GET'], async (request, response) => {
      await ensureLoaded()
      const sessionId = requireSessionId(sessionIdFromQuery(request.url))
      const root = await requireWorkspace(sessionId)
      const active = activeWorkbench(sessionId, root)
      const list = workbenchesForScope(sessionId, root).slice(0, 12).map((record) => ({
        id: record.id,
        title: record.title || record.source?.path || '',
        status: record.status,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        source: { path: record.source?.path ?? '' },
        stats: countDecisions(record.items),
        active: active !== undefined && active.id === record.id,
      }))
      sendJson(response, 200, { ok: true, root: toPosixPath(root), workbenches: list })
    })

    route('/activate', ['POST'], async (request, response) => {
      await ensureLoaded()
      const body = JSON.parse((await readBody(request)) || '{}')
      const sessionId = requireSessionId(body.sessionId)
      const root = await requireWorkspace(sessionId)
      const workbench = requireWorkbench(sessionId, body.workbenchId, root)
      activeByScope.set(scopeKey(sessionId, root), workbench.id)
      touch(workbench)
      await saveNow()
      await refreshSourceState(workbench)
      sendJson(response, 200, { ok: true, workbench })
    })

    route('/item', ['POST'], async (request, response) => {
      await ensureLoaded()
      const body = JSON.parse((await readBody(request)) || '{}')
      const sessionId = requireSessionId(body.sessionId)
      const root = await requireWorkspace(sessionId)
      const workbench = requireWorkbench(sessionId, body.workbenchId, root)
      const item = requireItem(workbench, body.itemId)
      item.lastViewedAt = Date.now()
      sendJson(response, 200, { ok: true, item })
    })

    route('/explain', ['POST'], async (request, response) => {
      await ensureLoaded()
      const body = JSON.parse((await readBody(request)) || '{}')
      const sessionId = requireSessionId(body.sessionId)
      const root = await requireWorkspace(sessionId)
      const workbench = requireActiveWorkbench(sessionId, body.workbenchId, root)
      const item = requireItem(workbench, body.itemId)
      void explainItem(workbench, item, body.force === true)
      sendJson(response, 200, { ok: true, item })
    })

    route('/examples', ['POST'], async (request, response) => {
      await ensureLoaded()
      const body = JSON.parse((await readBody(request)) || '{}')
      const sessionId = requireSessionId(body.sessionId)
      const root = await requireWorkspace(sessionId)
      const workbench = requireActiveWorkbench(sessionId, body.workbenchId, root)
      const item = requireItem(workbench, body.itemId)
      void generateExamples(workbench, item, body.force === true)
      sendJson(response, 200, { ok: true, item })
    })

    route('/options', ['POST'], async (request, response) => {
      await ensureLoaded()
      const body = JSON.parse((await readBody(request)) || '{}')
      const sessionId = requireSessionId(body.sessionId)
      const root = await requireWorkspace(sessionId)
      const workbench = requireActiveWorkbench(sessionId, body.workbenchId, root)
      const item = requireItem(workbench, body.itemId)
      void proposeOptions(workbench, item, body.force === true)
      sendJson(response, 200, { ok: true, item })
    })

    route('/ask', ['POST'], async (request, response) => {
      await ensureLoaded()
      const body = JSON.parse((await readBody(request)) || '{}')
      const sessionId = requireSessionId(body.sessionId)
      const root = await requireWorkspace(sessionId)
      const workbench = requireActiveWorkbench(sessionId, body.workbenchId, root)
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
      const root = await requireWorkspace(sessionId)
      const workbench = requireActiveWorkbench(sessionId, body.workbenchId, root)
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
      const root = await requireWorkspace(sessionId)
      // Preview is read-only, so a history workbench may be summarised too.
      const workbench = requireWorkbench(sessionId, body.workbenchId, root)
      await refreshSourceState(workbench)
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
      const root = await requireWorkspace(sessionId)
      const workbench = requireActiveWorkbench(sessionId, body.workbenchId, root)
      const stats = countDecisions(workbench.items)
      const autoRead = body.autoRead === true
      const locale = resolveLocale(body.locale)
      // The file is the durable result; if writing it fails the workbench stays
      // open so the user can retry. Notification is best effort, but the
      // workbench is done either way.
      const written = await writeResolution(workbench, root)
      // Remove the record before waking the session: by the time the agent
      // reads the notice, the workbench is already gone and the file is the
      // only source of truth.
      dropWorkbench(workbench)
      await saveNow()
      const notified = await notifyAgent(
        sessionId,
        buildFinishNotice({
          sourcePath: workbench.source.path,
          resolutionPath: written.path,
          stats,
          autoRead,
          locale,
        }),
      )
      sendJson(response, 200, {
        ok: true,
        deletedId: workbench.id,
        path: written.path,
        absolute: written.absolute,
        digest: written.digest,
        stats,
        autoRead,
        notified,
      })
    })

    route('/write', ['POST'], async (request, response) => {
      await ensureLoaded()
      const body = JSON.parse((await readBody(request)) || '{}')
      const sessionId = requireSessionId(body.sessionId)
      const root = await requireWorkspace(sessionId)
      const workbench = requireActiveWorkbench(sessionId, body.workbenchId, root)
      const written = await writeResolution(workbench, root)
      sendJson(response, 200, { ok: true, path: written.path, absolute: written.absolute })
    })

    route('/resync', ['POST'], async (request, response) => {
      await ensureLoaded()
      const body = JSON.parse((await readBody(request)) || '{}')
      const sessionId = requireSessionId(body.sessionId)
      const root = await requireWorkspace(sessionId)
      const workbench = requireActiveWorkbench(sessionId, body.workbenchId, root)
      await resyncSource(workbench)
      sendJson(response, 200, {
        ok: true,
        workbench,
        staleItems: workbench.items.filter((item) => item.sourceStale === true).map((item) => item.id),
        stats: countDecisions(workbench.items),
      })
    })

    // Workbenches are cheap to create but can accumulate in the picker. Delete
    // is scoped like every other route: another session or another workspace
    // gets the same 404 as an unknown id. Deleting the active workbench hands
    // "continue last" to the newest remaining one in this scope.
    route('/delete', ['POST'], async (request, response) => {
      await ensureLoaded()
      const body = JSON.parse((await readBody(request)) || '{}')
      const sessionId = requireSessionId(body.sessionId)
      const root = await requireWorkspace(sessionId)
      const workbenchId = typeof body.workbenchId === 'string' ? body.workbenchId : ''
      if (workbenchId === '') throw new HttpError(400, 'invalid', 'workbenchId is required')
      const workbench = requireWorkbench(sessionId, workbenchId, root)
      dropWorkbench(workbench)
      await saveNow()
      const remaining = activeWorkbench(sessionId, root)
      sendJson(response, 200, {
        ok: true,
        deletedId: workbench.id,
        activeId: remaining !== undefined ? remaining.id : '',
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
    const locale = resolveLocale()
    const sessionId = sessionIdOf(invocation.agent)
    if (sessionId === undefined) {
      return {
        kind: 'error',
        text: locale === 'zh' ? '无法确定当前会话，请重试。' : 'Could not determine the current session. Please retry.',
      }
    }
    const root = await resolveWorkspace(invocation.agent)
    if (root === undefined) {
      return {
        kind: 'error',
        text: locale === 'zh'
          ? '当前会话还没有工作区。先打开一个工作区，再运行 /decision。'
          : 'This session has no workspace yet. Open a workspace, then run /decision.',
      }
    }

    await ensureLoaded()

    const workspaceRoot = normalizeWorkspacePath(root)

    if (parsed.mode === 'pick') {
      setPending(sessionId, { mode: 'pick', workspaceRoot })
      return { kind: 'success', text: buildCommandHint({ locale, mode: 'pick' }) }
    }

    try {
      const document = await resolveDocument(root, parsed.arg)
      const workbench = await startFromDocument(sessionId, document, root)
      setPending(sessionId, { mode: 'workbench', workbenchId: workbench.id, workspaceRoot })
      return { kind: 'success', text: buildCommandHint({ locale, mode: 'file', path: document.rel }) }
    } catch (error) {
      return { kind: 'error', text: localizeCommandError(error, locale, parsed.arg) }
    }
  }

  ctx.effect(() =>
    ctx.commands.register({
      name: COMMAND_NAME,
      // No `input` descriptor on purpose: a descriptor turns the bare command
      // into a leading-input claim, so `/decision` + Enter only opens an
      // argument stage instead of executing. Without it, both `/decision` and
      // `/decision <file>` execute immediately.
      description: resolveLocale() === 'zh'
        ? '打开决策工作台：/decision 选择文件，/decision <文件名> 直接开始'
        : 'Open the Decision Workbench: /decision to pick a file, /decision <filename> to start directly',
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
