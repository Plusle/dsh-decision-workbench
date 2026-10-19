// dsh-decision-workbench - host half.
//
// Responsibilities in this scaffold (M1):
//
//   * register the `/decision` command;
//   * answer the browser half's loopback-only JSON routes;
//   * resolve a filename argument against the session workspace and list
//     candidate documents for the panel's file picker;
//   * keep the "open request" the panel picks up after the command runs.
//
// M2 adds the decision assistant session and the decision enumeration. The
// current workbench record is deliberately a placeholder: `/decision` opens the
// panel and the panel can pick a document, nothing is generated yet.
//
// The module imports nothing from the DSH SDK: `commands`, `webServer` and
// friends are resolved through the Cordis context, so the plugin loads on any
// profile that has them and degrades to a clear route error when one is absent.
import { randomUUID } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  COMMAND_NAME,
  PLUGIN_ID,
  ROUTE_PREFIX,
  isDocumentPath,
  isPathInside,
  parseDecisionInput,
  toPosixPath,
} from './shared.js'

// How long an unacknowledged open request stays valid. The panel polls every
// second, so this only protects against a request that arrives while no client
// is attached (for example, a command run from a second window).
const PENDING_TTL_MS = 60_000
const FILE_LIST_LIMIT = 200
const FILE_SCAN_DEPTH = 6
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.cache'])
const BODY_LIMIT_BYTES = 64 * 1024

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

function sessionCwd(agent) {
  const session = sessionOf(agent)
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
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

// --- Plugin -------------------------------------------------------------------

export const inject = ['commands']

export function apply(ctx) {
  /** sessionId -> { requestId, mode: 'pick' | 'file', file?, createdAt } */
  const pending = new Map()
  /** workbenchId -> workbench record (placeholder shape until M2) */
  const workbenches = new Map()
  /** sessionId -> workbenchId of the most recently opened workbench */
  const activeBySession = new Map()

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

  function createWorkbench(sessionId, document) {
    const workbench = {
      id: `dw_${randomUUID()}`,
      sessionId,
      status: 'scaffold',
      source: { kind: 'file', path: document.rel, abs: document.abs },
      createdAt: Date.now(),
      items: [],
    }
    workbenches.set(workbench.id, workbench)
    activeBySession.set(sessionId, workbench.id)
    return workbench
  }

  function activeWorkbench(sessionId) {
    const id = activeBySession.get(sessionId)
    return id === undefined ? undefined : workbenches.get(id)
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
                error: String((error && error.message) || error),
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
      const agent = ctx.get('agents')?.get?.(sessionId)
      const root = sessionCwd(agent)
      if (root === undefined) {
        throw new HttpError(409, 'no-workspace', '当前会话还没有工作区，先打开一个工作区再选择文件。')
      }
      sendJson(response, 200, { ok: true, root: toPosixPath(root), files: await listDocuments(root, query) })
    })

    route('/start', ['POST'], async (request, response) => {
      const body = JSON.parse((await readBody(request)) || '{}')
      const sessionId = requireSessionId(body.sessionId)
      const agent = ctx.get('agents')?.get?.(sessionId)
      const root = sessionCwd(agent)
      if (root === undefined) {
        throw new HttpError(409, 'no-workspace', '当前会话还没有工作区，先打开一个工作区再开始。')
      }
      if (typeof body.path !== 'string' || body.path.trim() === '') {
        throw new HttpError(400, 'invalid', '请选择一份文档。')
      }
      const document = await resolveDocument(root, body.path)
      const workbench = createWorkbench(sessionId, document)
      sendJson(response, 200, { ok: true, workbench })
    })

    route('/workbench', ['GET'], async (request, response) => {
      const sessionId = requireSessionId(sessionIdFromQuery(request.url))
      sendJson(response, 200, { ok: true, workbench: activeWorkbench(sessionId) ?? null })
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
    const root = sessionCwd(invocation.agent)
    if (root === undefined) {
      return { kind: 'error', text: '当前会话还没有工作区。先打开一个工作区，再运行 /decision。' }
    }

    if (parsed.mode === 'pick') {
      setPending(sessionId, { mode: 'pick' })
      return {
        kind: 'success',
        text: '决策工作台已打开。在右侧选择一份文档开始，或输入 /decision <文件名> 直接开始。',
      }
    }

    try {
      const document = await resolveDocument(root, parsed.arg)
      setPending(sessionId, { mode: 'file', file: document.rel })
      return { kind: 'success', text: `正在打开决策工作台：${document.rel}` }
    } catch (error) {
      const message = error instanceof HttpError ? error.message : '打开失败，请重试。'
      return { kind: 'error', text: message }
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
}
