// dsh-decision-workbench - browser half.
//
// Scaffold responsibilities (M1):
//
//   * register the `decision-workbench` right sidebar tab type and its body;
//   * watch for the open request the host writes when `/decision` runs, and
//     open/focus the tab for that session;
//   * render the file picker (`/decision`) or the started workbench shell
//     (`/decision <filename>`).
//
// M2 replaces the workbench shell with the decision list, per-question detail
// and the decision assistant thread.
//
// This module is a classic client bundle: it registers a factory with
// window.__ModuleLoader__ and exposes apply()/inject.
window.__ModuleLoader__.load({
  id: 'dsh-decision-workbench',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-decision-workbench'
    const ROUTE_PREFIX = '/dsh-decision-workbench'
    const TAB_KIND = 'decision-workbench'
    const TAB_ID = 'dsh-decision-workbench/workbench'
    const POLL_MS = 1000
    const RETRY_OPEN_MS = 3000

    // --- copy -----------------------------------------------------------------

    const zh = {
      'tab.title': '决策工作台',
      'picker.title': '选择一份文档开始',
      'picker.hint': '会从当前工作区里找 Markdown / 文本类文档。也可以直接用 /decision <文件名> 开始。',
      'picker.search': '搜索文件…',
      'picker.loading': '正在读取工作区…',
      'picker.empty': '工作区里没有找到可用的文档。',
      'picker.emptyQuery': '没有匹配的文件。',
      'picker.retry': '重试',
      'picker.noWorkspace': '当前会话还没有工作区。',
      'picker.select': '选这份',
      'workbench.loading': '正在读取工作台…',
      'workbench.source': '来源',
      'workbench.status.scaffold': '脚手架阶段：决策项生成尚未接入',
      'workbench.scaffold': '面板已创建。下一步（M2）会在这里列出全部决策项，并接入独立的决策助手。',
      'workbench.chooseAnother': '换一份文档',
      'workbench.error': '工作台加载失败。',
    }

    const en = {
      'tab.title': 'Decision Workbench',
      'picker.title': 'Choose a document to start',
      'picker.hint': 'Looks for Markdown and text documents in the current workspace. You can also start with /decision <filename>.',
      'picker.search': 'Search files…',
      'picker.loading': 'Reading the workspace…',
      'picker.empty': 'No usable documents were found in the workspace.',
      'picker.emptyQuery': 'No matching files.',
      'picker.retry': 'Retry',
      'picker.noWorkspace': 'This session has no workspace yet.',
      'picker.select': 'Use this',
      'workbench.loading': 'Loading the workbench…',
      'workbench.source': 'Source',
      'workbench.status.scaffold': 'Scaffold: decision generation is not wired yet',
      'workbench.scaffold': 'The panel exists. M2 adds the full decision list and the independent decision assistant here.',
      'workbench.chooseAnother': 'Choose another document',
      'workbench.error': 'The workbench failed to load.',
    }

    // --- tokens ---------------------------------------------------------------

    const colorPrimary = 'var(--dsw-alias-label-primary)'
    const colorSecondary = 'var(--dsw-alias-label-secondary)'
    const colorBorder = 'var(--dsw-alias-border-l1)'
    const colorBorderStrong = 'var(--dsw-alias-border-l2)'
    const colorLayer = 'var(--dsw-alias-bg-layer-1)'
    const colorBrand = 'var(--dsw-alias-brand-primary)'
    const colorError = 'var(--dsw-alias-state-error-primary)'

    const surface = {
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: 0,
      color: colorPrimary,
      background: 'var(--dsw-alias-bg-base)',
      font: 'inherit',
      fontSize: 13,
    }

    const padded = { padding: '16px 18px', minHeight: 0 }

    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '8px 10px',
      borderRadius: 8,
      border: `1px solid ${colorBorder}`,
      background: colorLayer,
      color: colorPrimary,
      font: 'inherit',
      outline: 'none',
    }

    function buttonStyle(primary) {
      return {
        padding: '6px 12px',
        borderRadius: 8,
        border: `1px solid ${primary ? colorBrand : colorBorder}`,
        background: primary ? colorBrand : colorLayer,
        color: primary ? '#ffffff' : colorPrimary,
        font: 'inherit',
        cursor: 'pointer',
      }
    }

    // --- transport ------------------------------------------------------------

    async function fetchJson(path, init) {
      const response = await fetch(`${ROUTE_PREFIX}${path}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...init,
        headers: {
          ...(init && init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(init && init.headers),
        },
      })
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!response.ok || data === null || data.ok === false) {
        const message = data && typeof data.error === 'string' ? data.error : `HTTP ${response.status}`
        throw new Error(message)
      }
      return data
    }

    function postJson(path, body) {
      return fetchJson(path, { method: 'POST', body: JSON.stringify(body) })
    }

    // --- host open-request listener -------------------------------------------

    // Kept outside module state on purpose: one listener per mounted session.
    function CommandListener(props) {
      const sessionId = props.sessionId
      const openTab = props.openTab
      React.useEffect(() => {
        if (!sessionId) return undefined
        let stopped = false
        let timer = null
        let lastAttempt = 0

        const tick = async () => {
          if (stopped) return
          try {
            const data = await fetchJson(`/pending?sessionId=${encodeURIComponent(sessionId)}`)
            const request = data.pending
            if (request) {
              const now = Date.now()
              if (now - lastAttempt >= RETRY_OPEN_MS) {
                lastAttempt = now
                await handleOpenRequest(sessionId, request, openTab)
              }
            }
          } catch {
            // The panel is optional; a failed poll retries on the next tick.
          }
          if (!stopped) timer = setTimeout(tick, POLL_MS)
        }

        tick()
        return () => {
          stopped = true
          if (timer !== null) clearTimeout(timer)
        }
      }, [sessionId, openTab])

      return null
    }

    async function handleOpenRequest(sessionId, request, openTab) {
      try {
        if (request.mode === 'file' && typeof request.file === 'string') {
          const started = await postJson('/start', { sessionId, path: request.file })
          openTab(TAB_KIND, {
            params: { mode: 'workbench', workbenchId: started.workbench.id, requestId: request.requestId },
          })
        } else {
          openTab(TAB_KIND, { params: { mode: 'pick', requestId: request.requestId } })
        }
        await postJson('/pending/ack', { sessionId, requestId: request.requestId })
      } catch (error) {
        // Leave the request pending; the next tick retries after RETRY_OPEN_MS.
        console.warn('[dsh-decision-workbench] open request not handled yet:', error)
      }
    }

    // --- file picker ----------------------------------------------------------

    function FilePicker(props) {
      const [query, setQuery] = React.useState('')
      const [files, setFiles] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [reloadKey, setReloadKey] = React.useState(0)
      const t = props.t

      React.useEffect(() => {
        let cancelled = false
        const timer = setTimeout(async () => {
          try {
            const data = await fetchJson(
              `/files?sessionId=${encodeURIComponent(props.sessionId)}&query=${encodeURIComponent(query)}`,
            )
            if (!cancelled) {
              setFiles(data.files)
              setError('')
            }
          } catch (failure) {
            if (!cancelled) {
              setFiles([])
              setError(String(failure.message || failure))
            }
          }
        }, 150)
        return () => {
          cancelled = true
          clearTimeout(timer)
        }
      }, [props.sessionId, query, reloadKey])

      const choose = async (path) => {
        if (busy !== '') return
        setBusy(path)
        try {
          const started = await postJson('/start', { sessionId: props.sessionId, path })
          props.onStarted(started.workbench)
        } catch (failure) {
          setError(String(failure.message || failure))
        } finally {
          setBusy('')
        }
      }

      return h(
        'div',
        { style: { ...surface, ...padded, gap: 12 } },
        h('div', { style: { fontSize: 15, fontWeight: 600 } }, t('picker.title')),
        h('div', { style: { color: colorSecondary, lineHeight: 1.6 } }, t('picker.hint')),
        h('input', {
          style: inputStyle,
          type: 'search',
          autoFocus: true,
          placeholder: t('picker.search'),
          value: query,
          onChange: (event) => setQuery(event.target.value),
          'aria-label': t('picker.search'),
        }),
        error !== ''
          ? h(
              'div',
              { style: { color: colorError, lineHeight: 1.6 } },
              error,
              h(
                'button',
                {
                  type: 'button',
                  style: { ...buttonStyle(false), marginLeft: 8 },
                  onClick: () => setReloadKey((key) => key + 1),
                },
                t('picker.retry'),
              ),
            )
          : null,
        files === null
          ? h('div', { style: { color: colorSecondary } }, t('picker.loading'))
          : files.length === 0
            ? h(
                'div',
                { style: { color: colorSecondary } },
                query === '' ? t('picker.empty') : t('picker.emptyQuery'),
              )
            : h(
                'ul',
                {
                  style: {
                    listStyle: 'none',
                    margin: 0,
                    padding: 0,
                    overflowY: 'auto',
                    flex: 1,
                    minHeight: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                  },
                },
                files.map((file) =>
                  h(
                    'li',
                    { key: file.path },
                    h(
                      'button',
                      {
                        type: 'button',
                        onClick: () => choose(file.path),
                        disabled: busy !== '',
                        title: file.path,
                        style: {
                          display: 'flex',
                          width: '100%',
                          alignItems: 'baseline',
                          gap: 8,
                          padding: '8px 10px',
                          borderRadius: 8,
                          border: '1px solid transparent',
                          background: 'transparent',
                          color: colorPrimary,
                          font: 'inherit',
                          textAlign: 'left',
                          cursor: busy === '' ? 'pointer' : 'default',
                        },
                        onMouseEnter: (event) => {
                          event.currentTarget.style.background = colorLayer
                          event.currentTarget.style.borderColor = colorBorder
                        },
                        onMouseLeave: (event) => {
                          event.currentTarget.style.background = 'transparent'
                          event.currentTarget.style.borderColor = 'transparent'
                        },
                      },
                      h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, file.name),
                      h(
                        'span',
                        {
                          style: {
                            color: colorSecondary,
                            fontSize: 12,
                            flex: '0 1 auto',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          },
                        },
                        file.dir === '' ? '.' : file.dir,
                      ),
                      busy === file.path ? h('span', { style: { color: colorBrand, fontSize: 12 } }, '…') : null,
                    ),
                  ),
                ),
              ),
      )
    }

    // --- workbench shell ------------------------------------------------------

    function WorkbenchShell(props) {
      const [workbench, setWorkbench] = React.useState(props.initialWorkbench ?? null)
      const [error, setError] = React.useState('')
      const t = props.t

      React.useEffect(() => {
        if (workbench !== null) return undefined
        let cancelled = false
        fetchJson(`/workbench?sessionId=${encodeURIComponent(props.sessionId)}`)
          .then((data) => {
            if (!cancelled) setWorkbench(data.workbench)
          })
          .catch((failure) => {
            if (!cancelled) setError(String(failure.message || failure))
          })
        return () => {
          cancelled = true
        }
      }, [props.sessionId, workbench])

      if (error !== '') {
        return h('div', { style: { ...surface, ...padded, gap: 8, color: colorError } }, t('workbench.error'), h('div', null, error))
      }
      if (workbench === null) {
        return h('div', { style: { ...surface, ...padded, color: colorSecondary } }, t('workbench.loading'))
      }

      return h(
        'div',
        { style: { ...surface, ...padded, gap: 12 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { color: colorSecondary } }, t('workbench.source')),
          h('span', { style: { fontWeight: 600, wordBreak: 'break-all' } }, workbench.source.path),
          h(
            'span',
            {
              style: {
                fontSize: 12,
                padding: '2px 8px',
                borderRadius: 999,
                border: `1px solid ${colorBorderStrong}`,
                color: colorSecondary,
              },
            },
            t('workbench.status.scaffold'),
          ),
        ),
        h(
          'div',
          {
            style: {
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              border: `1px dashed ${colorBorderStrong}`,
              borderRadius: 10,
              padding: 16,
              color: colorSecondary,
              lineHeight: 1.7,
            },
          },
          t('workbench.scaffold'),
        ),
        h(
          'div',
          null,
          h(
            'button',
            { type: 'button', style: buttonStyle(false), onClick: props.onChooseAnother },
            t('workbench.chooseAnother'),
          ),
        ),
      )
    }

    // --- tab body -------------------------------------------------------------

    function TabBody(props) {
      const t = props.t
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : null
      const params = (info && info.tab && info.tab.navigation && info.tab.navigation.params) || {}
      const [mode, setMode] = React.useState(params.mode === 'workbench' ? 'workbench' : 'pick')
      const [started, setStarted] = React.useState(null)

      React.useEffect(() => {
        if (params.mode === 'workbench') setMode('workbench')
        else if (params.mode === 'pick') setMode('pick')
      }, [params.mode])

      const sessionId = props.sessionId

      if (mode === 'workbench') {
        return h(WorkbenchShell, {
          t,
          sessionId,
          initialWorkbench: started,
          onChooseAnother: () => {
            setStarted(null)
            setMode('pick')
          },
        })
      }

      return h(FilePicker, {
        t,
        sessionId,
        onStarted: (workbench) => {
          setStarted(workbench)
          setMode('workbench')
        },
      })
    }

    // --- plugin ---------------------------------------------------------------

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-decision-workbench: dictionaries')

      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            title: () => t('tab.title'),
            keepMounted: true,
          }),
        'dsh-decision-workbench: tab type',
      )

      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, (props) => h(TabBody, { ...props, t })),
      )

      ctx.slots.inject('sidebar.right.pane.tab.title', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, () => h('span', null, t('tab.title'))),
      )

      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          { name: 'conversation.composer.dock', id: 'dsh-decision-workbench-listener', order: 42 },
          (props) =>
            h(CommandListener, {
              sessionId: props.sessionId,
              openTab: (kind, options) => ctx.sidebarRight.openTab(kind, options),
            }),
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']
    return module.exports
  },
})
