// Host-side test for POST /delete. The route is the only mutating path that
// accepts a history workbench, so it must still enforce the session + workspace
// scope and hand "continue last" to the newest remaining record.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../src/index.js'

const WORKSPACE = 'C:/work/project'

function record(id, sessionId, updatedAt, items = [], workspaceRoot = WORKSPACE) {
  const root = workspaceRoot.replace(/\\/g, '/')
  return {
    id,
    sessionId,
    workspaceRoot,
    revision: 1,
    status: 'ready',
    title: id,
    source: { kind: 'file', path: `${id}.md`, abs: `${root}/${id}.md` },
    createdAt: 1,
    updatedAt,
    items,
  }
}

function harness(workspace = WORKSPACE, messages = []) {
  const routes = new Map()
  const ctx = {
    effect(fn) {
      fn()
      return () => {}
    },
    get(name) {
      if (name === 'webServer') {
        return {
          register(definition) {
            routes.set(definition.path, definition.handler)
            return () => {}
          },
        }
      }
      if (name === 'agents') {
        return {
          get(id) {
            return {
              id,
              session: { header: { cwd: workspace } },
              followup: async (payload) => {
                messages.push(payload)
              },
            }
          },
        }
      }
      if (name === 'workingDirectory') {
        return { get: () => workspace }
      }
      return undefined
    },
    commands: { register: () => () => {} },
    inject(_names, callback) {
      callback(ctx)
    },
  }
  apply(ctx)
  return routes
}

function get(routes, path) {
  const routePath = path.split('?')[0]
  const handler = routes.get(`/dsh-decision-workbench${routePath}`)
  assert.equal(typeof handler, 'function')

  const request = Readable.from([])
  request.socket = { remoteAddress: '127.0.0.1' }
  request.headers = { host: '127.0.0.1', origin: 'http://127.0.0.1' }
  request.url = `/dsh-decision-workbench${path}`
  request.method = 'GET'

  return new Promise((resolve) => {
    const response = {
      statusCode: 0,
      setHeader() {},
      end(text) {
        resolve({ status: this.statusCode, body: JSON.parse(text) })
      },
    }
    handler(request, response).catch((error) => {
      resolve({ status: 500, body: { ok: false, error: String(error) } })
    })
  })
}

function post(routes, path, body) {
  const handler = routes.get(`/dsh-decision-workbench${path}`)
  assert.equal(typeof handler, 'function')

  // A paused Readable lets the route attach its body listeners after its
  // async `ensureLoaded()` step; an EventEmitter would lose the early chunks.
  const request = Readable.from([Buffer.from(JSON.stringify(body))])
  request.socket = { remoteAddress: '127.0.0.1' }
  request.headers = { host: '127.0.0.1', origin: 'http://127.0.0.1' }
  request.url = `/dsh-decision-workbench${path}`
  request.method = 'POST'

  return new Promise((resolve) => {
    const response = {
      statusCode: 0,
      setHeader() {},
      end(text) {
        resolve({ status: this.statusCode, body: JSON.parse(text) })
      },
    }
    handler(request, response).catch((error) => {
      resolve({ status: 500, body: { ok: false, error: String(error) } })
    })
  })
}

test('deleting a workbench is scoped and re-points the active record', async () => {
  const previousHome = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'dsh-dw-delete-'))
  const storeDir = join(home, 'storages', 'dsh-decision-workbench')
  const storeFile = join(storeDir, 'workbenches.json')

  try {
    await mkdir(storeDir, { recursive: true })
    await writeFile(
      storeFile,
      JSON.stringify({
        version: 1,
        workbenches: [
          record('dw_a', 's1', 10),
          record('dw_b', 's1', 20),
          record('dw_other', 's2', 30),
          { ...record('dw_other_ws', 's1', 40), workspaceRoot: 'C:/work/other' },
        ],
      }),
      'utf8',
    )
    process.env.DSH_HOME = home

    const routes = harness()

    // The newest record in s1 is active; deleting it falls back to dw_a.
    let result = await post(routes, '/delete', { sessionId: 's1', workbenchId: 'dw_b' })
    assert.equal(result.status, 200)
    assert.equal(result.body.deletedId, 'dw_b')
    assert.equal(result.body.activeId, 'dw_a')

    // Another session's record is invisible from s1, even with its exact id.
    result = await post(routes, '/delete', { sessionId: 's1', workbenchId: 'dw_other' })
    assert.equal(result.status, 404)
    assert.equal(result.body.code, 'workbench-not-found')

    // The same session pointed at another workspace is invisible too.
    result = await post(routes, '/delete', { sessionId: 's1', workbenchId: 'dw_other_ws' })
    assert.equal(result.status, 404)
    assert.equal(result.body.code, 'workbench-other-workspace')

    // An omitted id is rejected instead of silently deleting the active record.
    result = await post(routes, '/delete', { sessionId: 's1' })
    assert.equal(result.status, 400)

    // Removing the last record in the scope clears the active pointer.
    result = await post(routes, '/delete', { sessionId: 's1', workbenchId: 'dw_a' })
    assert.equal(result.status, 200)
    assert.equal(result.body.activeId, '')

    result = await post(routes, '/delete', { sessionId: 's1', workbenchId: 'dw_a' })
    assert.equal(result.status, 404)

    const saved = JSON.parse(await readFile(storeFile, 'utf8'))
    assert.deepEqual(
      saved.workbenches.map((workbench) => workbench.id),
      ['dw_other_ws', 'dw_other'],
    )
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})
test('finishing writes a resolution file, notifies the session, and removes the workbench', async () => {
  const previousHome = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'dsh-dw-finish-'))
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-dw-finish-ws-'))
  const storeDir = join(home, 'storages', 'dsh-decision-workbench')
  const storeFile = join(storeDir, 'workbenches.json')
  const messages = []

  try {
    const items = [
      {
        id: 'd1',
        title: '退款渠道',
        question: '退款打到哪里？',
        priority: 'blocking',
        status: 'decided',
        source: { path: 'docs/spec.md', line: 3 },
        options: [{ id: 'o1', label: '微信原路退回', tradeoff: '改动最小', bestWhen: '', risk: '', from: 'spec' }],
        recommendation: { optionId: 'o1', why: '改动最小' },
        decision: { optionIds: ['o1'], custom: '', rationale: '改动最小', at: 1 },
        thread: [],
        explanationState: 'idle',
        examplesState: 'idle',
        optionsState: 'idle',
        threadState: 'idle',
      },
      {
        id: 'd2',
        title: '对账口径',
        question: '按支付时间还是退款时间？',
        priority: 'important',
        status: 'unsure',
        source: { path: 'docs/spec.md', line: 8 },
        options: [],
        optionsOrigin: 'none',
        decision: { optionIds: [], custom: '', rationale: '等财务确认', at: 2 },
        thread: [],
        explanationState: 'idle',
        examplesState: 'idle',
        optionsState: 'idle',
        threadState: 'idle',
      },
    ]
    const workbench = record('dw_finish', 's1', 10, items, workspace)
    workbench.title = '支付重构'
    workbench.source = { kind: 'file', path: 'docs/spec.md', abs: join(workspace, 'docs/spec.md') }
    const autoWorkbench = record('dw_finish_auto', 's1', 5, items, workspace)
    autoWorkbench.title = '支付重构（立即读取）'
    autoWorkbench.source = { kind: 'file', path: 'docs/spec.md', abs: join(workspace, 'docs/spec.md') }

    await mkdir(storeDir, { recursive: true })
    await writeFile(
      storeFile,
      JSON.stringify({ version: 1, workbenches: [workbench, autoWorkbench] }),
      'utf8',
    )
    process.env.DSH_HOME = home

    const routes = harness(workspace, messages)
    const result = await post(routes, '/submit', {
      sessionId: 's1',
      workbenchId: 'dw_finish',
      autoRead: false,
      locale: 'zh',
    })

    assert.equal(result.status, 200)
    assert.equal(result.body.deletedId, 'dw_finish')
    assert.equal(result.body.notified, true)
    assert.equal(result.body.autoRead, false)
    assert.match(result.body.path, /^docs\/decisions\/\d{4}-\d{2}-\d{2}-.+\.md$/)

    const target = join(workspace, ...result.body.path.split('/'))
    const content = await readFile(target, 'utf8')
    assert.match(content, /^# 决策结果：支付重构/m)
    assert.ok(content.includes('> 来源：`docs/spec.md`'))
    assert.match(content, /## 已决定（1 项）/)
    assert.match(content, /微信原路退回/)
    assert.match(content, /## 拿不准（1 项）/)
    assert.match(content, /等财务确认/)

    assert.equal(messages.length, 1)
    assert.equal(messages[0].role, 'user')
    assert.equal(typeof messages[0].id, 'string')
    const notice = messages[0].content[0].text
    assert.match(notice, /\[决策工作台\] 工作完成/)
    assert.ok(notice.includes(`结果文件：${result.body.path}`))
    assert.match(notice, /统计：已决定 1 \/ 拿不准 1 \/ 稍后 0 \/ 未处理 0/)
    assert.match(notice, /不要读取结果文件/)
    assert.match(notice, /等待用户下一步指令/)

    // The older record becomes active after the first finish, and autoRead
    // flips the notice to an explicit read request.
    const autoResult = await post(routes, '/submit', {
      sessionId: 's1',
      workbenchId: 'dw_finish_auto',
      autoRead: true,
      locale: 'en',
    })
    assert.equal(autoResult.status, 200)
    assert.equal(autoResult.body.autoRead, true)
    assert.equal(autoResult.body.notified, true)
    assert.equal(messages.length, 2)
    const autoNotice = messages[1].content[0].text
    assert.match(autoNotice, /\[Decision Workbench\] Work completed/)
    assert.match(autoNotice, /Read the result file/)
    assert.match(autoNotice, /immediately start implementing the decided items/)
    assert.match(autoNotice, /do not reply with an acknowledgement first/)
    assert.doesNotMatch(autoNotice, /reply only "Received"/)
    assert.doesNotMatch(autoNotice, /Do not start executing/)
    assert.match(autoNotice, /Never guess the unsure, deferred, or untouched items/)

    const saved = JSON.parse(await readFile(storeFile, 'utf8'))
    assert.deepEqual(saved.workbenches, [])
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})
test('starting a workbench tells the session to wait and only acknowledge', async () => {
  const previousHome = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'dsh-dw-start-'))
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-dw-start-ws-'))
  const storeDir = join(home, 'storages', 'dsh-decision-workbench')
  const storeFile = join(storeDir, 'workbenches.json')
  const messages = []

  try {
    await writeFile(join(workspace, 'spec.md'), '# 支付重构\n\n待定：退款渠道。\n', 'utf8')
    await mkdir(storeDir, { recursive: true })
    await writeFile(storeFile, JSON.stringify({ version: 1, workbenches: [] }), 'utf8')
    process.env.DSH_HOME = home

    const routes = harness(workspace, messages)
    const result = await post(routes, '/start', { sessionId: 's1', path: 'spec.md' })
    assert.equal(result.status, 200)
    assert.equal(result.body.workbench.source.path, 'spec.md')

    // The panel sends the localized start notice after it opens.
    assert.equal(messages.length, 0)
    const noticeResult = await post(routes, '/start-notice', {
      sessionId: 's1',
      workbenchId: result.body.workbench.id,
      locale: 'en',
    })
    assert.equal(noticeResult.status, 200)
    assert.equal(noticeResult.body.notified, true)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].role, 'user')
    assert.equal(typeof messages[0].id, 'string')
    const notice = messages[0].content[0].text
    assert.match(notice, /\[Decision Workbench\] Work started/)
    assert.ok(notice.includes('Input file: spec.md'))
    assert.match(notice, /Received, waiting for the result/)
    assert.match(notice, /do not start implementing/)

    const again = await post(routes, '/start-notice', {
      sessionId: 's1',
      workbenchId: result.body.workbench.id,
      locale: 'en',
    })
    assert.equal(again.status, 200)
    assert.equal(again.body.already, true)
    assert.equal(messages.length, 1)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})
test('the file picker requires a query and skips generated directories', async () => {
  const previousHome = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'dsh-dw-files-'))
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-dw-files-ws-'))
  const storeDir = join(home, 'storages', 'dsh-decision-workbench')
  const storeFile = join(storeDir, 'workbenches.json')

  try {
    await mkdir(join(workspace, 'docs', 'nested'), { recursive: true })
    await mkdir(join(workspace, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(workspace, 'README.md'), '# readme\n', 'utf8')
    await writeFile(join(workspace, 'docs', 'spec.md'), '# spec\n', 'utf8')
    await writeFile(join(workspace, 'docs', 'nested', 'plan.md'), '# plan\n', 'utf8')
    await writeFile(join(workspace, 'node_modules', 'pkg', 'readme.md'), '# ignored\n', 'utf8')
    await mkdir(storeDir, { recursive: true })
    await writeFile(storeFile, JSON.stringify({ version: 1, workbenches: [] }), 'utf8')
    process.env.DSH_HOME = home

    const routes = harness(workspace)

    // Empty query must not enumerate the project.
    const empty = await get(routes, '/files?sessionId=s1&query=')
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.body.files, [])

    // A relative path walks only that subtree.
    const docs = await get(routes, '/files?sessionId=s1&query=docs%2F')
    assert.equal(docs.status, 200)
    const docsPaths = docs.body.files.map((file) => file.path)
    assert.ok(docsPaths.includes('docs/spec.md'))
    assert.ok(docsPaths.includes('docs/nested/plan.md'))
    assert.ok(!docsPaths.some((path) => path.includes('node_modules')))

    // A name-only query uses the bounded workspace index.
    const byName = await get(routes, '/files?sessionId=s1&query=plan')
    assert.equal(byName.status, 200)
    assert.ok(byName.body.files.some((file) => file.path === 'docs/nested/plan.md'))
    assert.ok(!byName.body.files.some((file) => file.path.includes('node_modules')))
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})



