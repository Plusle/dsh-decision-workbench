// dsh-decision-workbench - browser half.
//
// Responsibilities:
//
//   * register the `decision-workbench` right sidebar tab type and its body;
//   * watch for the open request the host writes when `/decision` runs, and
//     open/focus the tab for that session;
//   * render the file picker (`/decision`), the decision list, the per-question
//     detail with lazy explanation/options, the decision assistant thread, and
//     the digest preview/submit flow.
//
// The host does every model call and every file read; this module only speaks
// the loopback JSON routes under /dsh-decision-workbench.
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
    // Below this pane width the two-column workbench becomes list → detail.
    const SPLIT_MIN_WIDTH = 520

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
      'picker.resume': '继续上次的工作台',
      'picker.resumeDecided': '已决定',
      'picker.resumeContinue': '继续',
      'workbench.loading': '正在读取工作台…',
      'workbench.error': '工作台加载失败。',
      'workbench.retry': '重试',
      'workbench.chooseAnother': '换一份文档',
      'workbench.summary': '摘要',
      'workbench.generating': '正在通读文档，整理需要你决定的点…',
      'workbench.generatingHint': '通常需要 10–40 秒；可以关掉面板，稍后回来会继续。',
      'workbench.failed': '这份文档没有生成成功。',
      'workbench.empty': '这份文档里没有找到需要你决定的点。',
      'workbench.emptyHint': '它可能更偏说明或记录。换一份 spec / 需求稿试试。',
      'workbench.regenerate': '重新生成',
      'workbench.progress': '已决定',
      'workbench.blockingLeft': '必决还剩',
      'list.title': '决策清单',
      'detail.empty': '从左侧选择一题开始',
      'filter.all': '全部',
      'filter.open': '未完成',
      'priority.blocking': '必决',
      'priority.important': '建议',
      'priority.optional': '可选',
      'status.decided': '已决定',
      'status.unsure': '拿不准',
      'status.deferred': '稍后',
      'status.unseen': '未决定',
      'detail.back': '返回清单',
      'detail.question': '要决定什么',
      'detail.source': '出处',
      'detail.whyNow': '为什么现在要决定',
      'detail.background': '背景',
      'detail.if': '如果',
      'detail.then': '则',
      'detail.impact': '影响',
      'detail.assumptions': '需要确认的假设',
      'detail.citations': '引用',
      'detail.options': '备选方案',
      'detail.optionsFromSpec': '来自 spec',
      'detail.optionsGenerated': '助手补充',
      'detail.noOptions': '文档没有为这一项给出备选方案。',
      'detail.generateOptions': '让助手补充 2–3 个方案',
      'detail.generatingOptions': '正在结合文档补充方案…',
      'detail.optionsError': '方案生成失败：',
      'detail.recommendation': '推荐',
      'detail.custom': '自定义方案',
      'detail.customPlaceholder': '如果以上都不合适，写下你的方案',
      'detail.rationale': '理由（可选）',
      'detail.rationalePlaceholder': '为什么这样选？会写进摘要，帮主 agent 后续判断。',
      'detail.decide': '已决定',
      'detail.unsure': '拿不准',
      'detail.deferred': '稍后',
      'detail.clear': '清除本题决定',
      'detail.saved': '已记录你的选择',
      'detail.chooseFirst': '先选择一个方案，或写自定义方案。',
      'detail.saving': '保存中…',
      'detail.next': '下一题',
      'ask.title': '问一问决策助手',
      'ask.hint': '它工作在一个独立上下文里，不会干扰主对话；回答会带文档出处。',
      'ask.placeholder': '针对这一项提问，Enter 发送，Shift+Enter 换行',
      'ask.send': '发送',
      'ask.pending': '正在查文档并整理回答…',
      'ask.suggest1': '这一项如果不决定会怎样？',
      'ask.suggest2': '两个方案最大的差别是什么？',
      'ask.suggest3': '业界通常怎么做？',
      'digest.title': '决定摘要',
      'digest.submit': '提交到主会话',
      'digest.cancel': '返回',
      'digest.copy': '复制摘要',
      'digest.copied': '已复制',
      'digest.write': '同时写入 docs/decisions/',
      'digest.warning': '还有未定项（拿不准 / 稍后 / 未处理）。提交后主会话会看到它们仍待定，不会被猜测。',
      'digest.submitting': '正在提交…',
      'digest.submitted': '已提交到主会话',
      'digest.done': '完成',
      'digest.noAgent': '主会话当前不在运行，无法回写。可以先复制摘要保存。',
      'notice.submitted': '摘要已提交到主会话',
      'notice.written': '决策记录已写入：',
      'notice.writeFailed': '写入失败：',
      'notice.decideFailed': '保存决定失败：',
      'notice.submitFailed': '提交失败：',
      'notice.askFailed': '提问失败：',
      'notice.explainFailed': '解释生成失败：',
      'notice.optionsFailed': '方案生成失败：',
      'notice.openFailed': '打开工作台失败：',
      'submitted.banner': '摘要已提交。主会话会按「已决定」继续；拿不准和未处理项不会被猜测。',
      'submitted.view': '查看摘要',
      // 0.3.0: on-demand explanation / examples, source health, history, read-only.
      'detail.explainSection': '讲解这一项',
      'detail.explainHint': '打开这一项不会自动生成讲解：需要时再点，省 token。',
      'detail.explainButton': '让助手讲解这一项',
      'detail.explainRetry': '重新生成讲解',
      'detail.explainLoading': '正在读文档，整理这一项的背景…',
      'detail.explainFailed': '讲解生成失败：',
      'detail.examplesSection': '实际例子',
      'detail.examplesHint': '想知道“选 A 会怎样、一直不定会怎样”时再生成。',
      'detail.examplesButton': '举 2–3 个具体例子',
      'detail.examplesRetry': '重新生成例子',
      'detail.examplesLoading': '正在结合文档写具体例子…',
      'detail.examplesFailed': '例子生成失败：',
      'detail.examplesFromExplain': '来自讲解',
      'detail.mergedPrefix': '已合并相似决策 ',
      'detail.mergedSuffix': ' 项',
      'detail.sourceStale': '出处可能失效',
      'workbench.stale': '来源文档已更新，部分出处可能需要复核。',
      'workbench.resync': '重新同步',
      'workbench.resyncing': '正在重新同步…',
      'workbench.missing': '来源文档已不存在，无法继续读取。',
      'workbench.resyncedOk': '已重新同步，出处都还在。',
      'workbench.resyncedStalePrefix': '已重新同步，出处失效 ',
      'workbench.resyncedStaleSuffix': ' 项，请复核。',
      'history.title': '历史工作台',
      'history.view': '查看',
      'history.continue': '继续',
      'history.current': '当前',
      'readOnly.banner': '历史工作台（只读）。可以查看已有的讲解、例子和决定；要修改请点「继续这个工作台」。',
      'readOnly.continue': '继续这个工作台',
      'readOnly.explainHint': '只读模式：继续这个工作台后才能生成讲解。',
      'readOnly.examplesHint': '只读模式：继续这个工作台后才能生成例子。',
      'notice.activateFailed': '切换工作台失败：',
      'notice.resyncFailed': '重新同步失败：',
      'notice.examplesFailed': '例子生成失败：',
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
      'picker.resume': 'Continue the last workbench',
      'picker.resumeDecided': 'Decided',
      'picker.resumeContinue': 'Continue',
      'workbench.loading': 'Loading the workbench…',
      'workbench.error': 'The workbench failed to load.',
      'workbench.retry': 'Retry',
      'workbench.chooseAnother': 'Choose another document',
      'workbench.summary': 'Summary',
      'workbench.generating': 'Reading the document and collecting the decisions you need to make…',
      'workbench.generatingHint': 'Usually 10–40 seconds. You can close the panel and come back later.',
      'workbench.failed': 'This document could not be processed.',
      'workbench.empty': 'No decisions were found in this document.',
      'workbench.emptyHint': 'It may be explanatory rather than a spec. Try another spec or requirements document.',
      'workbench.regenerate': 'Generate again',
      'workbench.progress': 'Decided',
      'workbench.blockingLeft': 'Blocking left',
      'list.title': 'Decisions',
      'detail.empty': 'Choose a decision on the left',
      'filter.all': 'All',
      'filter.open': 'Open',
      'priority.blocking': 'Blocking',
      'priority.important': 'Suggested',
      'priority.optional': 'Optional',
      'status.decided': 'Decided',
      'status.unsure': 'Unsure',
      'status.deferred': 'Later',
      'status.unseen': 'Undecided',
      'detail.back': 'Back to list',
      'detail.question': 'What to decide',
      'detail.source': 'Source',
      'detail.whyNow': 'Why now',
      'detail.background': 'Background',
      'detail.if': 'If',
      'detail.then': 'then',
      'detail.impact': 'Impact',
      'detail.assumptions': 'Assumptions to confirm',
      'detail.citations': 'Citations',
      'detail.options': 'Options',
      'detail.optionsFromSpec': 'From the spec',
      'detail.optionsGenerated': 'Suggested by assistant',
      'detail.noOptions': 'The document gives no options for this decision.',
      'detail.generateOptions': 'Ask the assistant for 2–3 options',
      'detail.generatingOptions': 'Reading the document and drafting options…',
      'detail.optionsError': 'Option generation failed: ',
      'detail.recommendation': 'Recommendation',
      'detail.custom': 'Custom option',
      'detail.customPlaceholder': 'If none of the above fit, describe your own option',
      'detail.rationale': 'Rationale (optional)',
      'detail.rationalePlaceholder': 'Why this choice? It goes into the summary and helps the main agent later.',
      'detail.decide': 'Decide',
      'detail.unsure': 'Unsure',
      'detail.deferred': 'Later',
      'detail.clear': 'Clear this decision',
      'detail.saved': 'Your choice is recorded',
      'detail.chooseFirst': 'Choose an option or write a custom one first.',
      'detail.saving': 'Saving…',
      'detail.next': 'Next',
      'ask.title': 'Ask the decision assistant',
      'ask.hint': 'It works in a separate context and never touches the main conversation. Answers cite the document.',
      'ask.placeholder': 'Ask about this decision. Enter sends, Shift+Enter adds a line',
      'ask.send': 'Send',
      'ask.pending': 'Checking the document and preparing an answer…',
      'ask.suggest1': 'What happens if we do not decide this?',
      'ask.suggest2': 'What is the biggest difference between the options?',
      'ask.suggest3': 'What is the common practice here?',
      'digest.title': 'Decision summary',
      'digest.submit': 'Submit to main session',
      'digest.cancel': 'Back',
      'digest.copy': 'Copy summary',
      'digest.copied': 'Copied',
      'digest.write': 'Also write docs/decisions/',
      'digest.warning': 'Some decisions are unresolved (unsure / later / untouched). The main session will see them as still open, never guessed.',
      'digest.submitting': 'Submitting…',
      'digest.submitted': 'Submitted to the main session',
      'digest.done': 'Done',
      'digest.noAgent': 'The main session is not running, so it cannot receive the summary. Copy it instead.',
      'notice.submitted': 'Summary submitted to the main session',
      'notice.written': 'Decision record written: ',
      'notice.writeFailed': 'Write failed: ',
      'notice.decideFailed': 'Saving the decision failed: ',
      'notice.submitFailed': 'Submit failed: ',
      'notice.askFailed': 'Ask failed: ',
      'notice.explainFailed': 'Explanation failed: ',
      'notice.optionsFailed': 'Option generation failed: ',
      'notice.openFailed': 'Opening the workbench failed: ',
      'submitted.banner': 'Summary submitted. The main session follows the decided items; unsure and untouched items are never guessed.',
      'submitted.view': 'View summary',
      // 0.3.0: on-demand explanation / examples, source health, history, read-only.
      'detail.explainSection': 'Explanation',
      'detail.explainHint': 'Opening an item does not generate anything. Ask when you need it and save tokens.',
      'detail.explainButton': 'Explain this decision',
      'detail.explainRetry': 'Regenerate explanation',
      'detail.explainLoading': 'Reading the document and preparing the background…',
      'detail.explainFailed': 'Explanation failed: ',
      'detail.examplesSection': 'Concrete examples',
      'detail.examplesHint': 'Generate these only when you want to see what picking A, or waiting, actually does.',
      'detail.examplesButton': 'Give me 2–3 concrete examples',
      'detail.examplesRetry': 'Regenerate examples',
      'detail.examplesLoading': 'Drafting concrete examples from the document…',
      'detail.examplesFailed': 'Examples failed: ',
      'detail.examplesFromExplain': 'From the explanation',
      'detail.mergedPrefix': 'Merged ',
      'detail.mergedSuffix': ' similar decisions',
      'detail.sourceStale': 'Citation may be stale',
      'workbench.stale': 'The source document changed; some citations may need a second look.',
      'workbench.resync': 'Resync',
      'workbench.resyncing': 'Resyncing…',
      'workbench.missing': 'The source document no longer exists.',
      'workbench.resyncedOk': 'Resynced; every citation is still findable.',
      'workbench.resyncedStalePrefix': 'Resynced; ',
      'workbench.resyncedStaleSuffix': ' citation(s) went stale, please review.',
      'history.title': 'Previous workbenches',
      'history.view': 'View',
      'history.continue': 'Continue',
      'history.current': 'Current',
      'readOnly.banner': 'Previous workbench (read-only). Existing explanations, examples and decisions are visible; press “Continue this workbench” to edit.',
      'readOnly.continue': 'Continue this workbench',
      'readOnly.explainHint': 'Read-only: continue this workbench to generate an explanation.',
      'readOnly.examplesHint': 'Read-only: continue this workbench to generate examples.',
      'notice.activateFailed': 'Switching workbench failed: ',
      'notice.resyncFailed': 'Resync failed: ',
      'notice.examplesFailed': 'Examples failed: ',
    }

    // --- tokens ---------------------------------------------------------------

    const T = {
      base: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      overlay: 'var(--dsw-alias-bg-overlay)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      brand: 'var(--dsw-alias-brand-primary)',
      primary: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      error: 'var(--dsw-alias-state-error-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    const KEYFRAMES = '@keyframes dsw-dw-spin{to{transform:rotate(360deg)}}@keyframes dsw-dw-pulse{0%,100%{opacity:.35}50%{opacity:1}}'

    const surface = {
      position: 'relative',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: 0,
      overflow: 'hidden',
      color: T.primary,
      background: T.base,
      font: 'inherit',
      fontSize: 13,
      lineHeight: 1.55,
    }

    const scrollArea = {
      flex: 1,
      minHeight: 0,
      overflowY: 'auto',
      overscrollBehavior: 'contain',
    }

    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '8px 10px',
      borderRadius: 8,
      border: `1px solid ${T.border}`,
      background: T.layer1,
      color: T.primary,
      font: 'inherit',
      outline: 'none',
    }

    function buttonStyle(primary, small) {
      return {
        padding: small ? '4px 9px' : '6px 12px',
        borderRadius: 7,
        border: `1px solid ${primary ? T.brand : T.border}`,
        background: primary ? T.brand : 'transparent',
        color: primary ? '#ffffff' : T.primary,
        font: 'inherit',
        fontSize: small ? 12 : 13,
        lineHeight: 1.45,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }
    }

    const linkStyle = {
      padding: '2px 0',
      border: 'none',
      background: 'transparent',
      color: T.secondary,
      font: 'inherit',
      fontSize: 12,
      cursor: 'pointer',
      textDecoration: 'underline',
      textUnderlineOffset: 2,
    }

    const card = {
      border: `1px solid ${T.border}`,
      borderRadius: 10,
      background: T.layer1,
      padding: '10px 12px',
    }

    const sectionTitle = {
      fontSize: 12,
      fontWeight: 600,
      letterSpacing: '0.04em',
      color: T.secondary,
      textTransform: 'uppercase',
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

    // --- small building blocks ------------------------------------------------

    function Spinner(props) {
      return h('span', {
        'aria-hidden': true,
        style: {
          display: 'inline-block',
          width: props.size || 14,
          height: props.size || 14,
          borderRadius: '50%',
          border: `2px solid ${T.borderStrong}`,
          borderTopColor: T.brand,
          animation: 'dsw-dw-spin .8s linear infinite',
          flex: '0 0 auto',
        },
      })
    }

    function LoadingLine(props) {
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8, color: T.secondary, padding: '6px 0' } },
        h(Spinner),
        h('span', null, props.text),
      )
    }

    function Chip(props) {
      return h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '1px 7px',
            borderRadius: 999,
            border: `1px solid ${props.color || T.border}`,
            color: props.color || T.secondary,
            fontSize: 11,
            lineHeight: 1.6,
            whiteSpace: 'nowrap',
          },
        },
        props.children,
      )
    }

    function PriorityChip(props) {
      const color = props.priority === 'blocking' ? T.error : props.priority === 'optional' ? T.idle : T.warn
      const key = props.priority === 'blocking' ? 'priority.blocking' : props.priority === 'optional' ? 'priority.optional' : 'priority.important'
      return h(Chip, { color }, props.t(key))
    }

    function StatusMark(props) {
      const status = props.status || 'unseen'
      const color =
        status === 'decided' ? T.success : status === 'unsure' ? T.warn : status === 'deferred' ? T.secondary : T.idle
      const glyph = status === 'decided' ? '✓' : status === 'unsure' ? '?' : status === 'deferred' ? '·' : ''
      return h(
        'span',
        {
          'aria-hidden': true,
          style: {
            width: 18,
            height: 18,
            borderRadius: '50%',
            border: `1px ${status === 'unseen' ? 'dashed' : 'solid'} ${color}`,
            color,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            fontWeight: 700,
            flex: '0 0 auto',
          },
        },
        glyph,
      )
    }

    function countItems(items) {
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

    function decisionText(item) {
      if (!item || !item.decision) return ''
      const labels = []
      for (const id of Array.isArray(item.decision.optionIds) ? item.decision.optionIds : []) {
        const option = (item.options || []).find((entry) => entry.id === id)
        if (option) labels.push(option.label)
      }
      const parts = []
      if (labels.length > 0) parts.push(labels.join('、'))
      if (typeof item.decision.custom === 'string' && item.decision.custom.trim() !== '') {
        parts.push(labels.length > 0 ? `自定义补充：${item.decision.custom.trim()}` : `自定义：${item.decision.custom.trim()}`)
      }
      return parts.join('；')
    }

    function sourceLabel(source) {
      if (!source) return ''
      return `${source.path || ''}${source.line ? `:${source.line}` : ''}`
    }

    const priorityOrder = ['blocking', 'important', 'optional']

    // --- host open-request listener -------------------------------------------

    function CommandListener(props) {
      const sessionId = props.sessionId
      const openTabRef = React.useRef(props.openTab)
      openTabRef.current = props.openTab
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
                await handleOpenRequest(sessionId, request, openTabRef.current)
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
      }, [sessionId])

      return null
    }

    async function handleOpenRequest(sessionId, request, openTab) {
      try {
        if (request.mode === 'workbench' && typeof request.workbenchId === 'string') {
          openTab(TAB_KIND, { params: { mode: 'workbench', workbenchId: request.workbenchId } })
        } else if (request.mode === 'file' && typeof request.file === 'string') {
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
      const [resume, setResume] = React.useState(null)
      const [history, setHistory] = React.useState(null)
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

      React.useEffect(() => {
        let cancelled = false
        fetchJson(`/workbench?sessionId=${encodeURIComponent(props.sessionId)}`)
          .then((data) => {
            if (!cancelled && data.workbench) setResume(data.workbench)
          })
          .catch(() => {})
        return () => {
          cancelled = true
        }
      }, [props.sessionId])

      // History is scoped server-side to this session AND this workspace; the
      // picker only ever renders what the host already decided it may see.
      React.useEffect(() => {
        let cancelled = false
        fetchJson(`/workbenches?sessionId=${encodeURIComponent(props.sessionId)}`)
          .then((data) => {
            if (!cancelled) setHistory(Array.isArray(data.workbenches) ? data.workbenches : [])
          })
          .catch(() => {
            if (!cancelled) setHistory([])
          })
        return () => {
          cancelled = true
        }
      }, [props.sessionId, reloadKey])

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

      const resumeStats = resume ? countItems(resume.items || []) : null
      const resumeStatus =
        resume && resume.status === 'submitted'
          ? t('status.decided')
          : resume && resume.status === 'generating'
            ? t('workbench.generating')
            : ''

      return h(
        'div',
        { style: { ...surface } },
        h(
          'div',
          { style: { padding: '14px 14px 10px', borderBottom: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', gap: 6 } },
          h('div', { style: { fontSize: 15, fontWeight: 600 } }, t('picker.title')),
          h('div', { style: { color: T.secondary, lineHeight: 1.55, fontSize: 12 } }, t('picker.hint')),
        ),
        h(
          'div',
          { style: { padding: '10px 14px 0', display: 'flex', flexDirection: 'column', gap: 8 } },
          resume
            ? h(
                'div',
                { style: { ...card, display: 'flex', flexDirection: 'column', gap: 6, borderColor: T.borderStrong } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } }, h('span', { style: { fontSize: 12, fontWeight: 600 } }, t('picker.resume')), h(StatusMark, { status: resume.status === 'submitted' ? 'decided' : 'unseen' })),
                h('div', { style: { fontSize: 12, color: T.secondary, wordBreak: 'break-all' } }, resume.source.path),
                resumeStats
                  ? h(
                      'div',
                      { style: { fontSize: 12, color: T.secondary } },
                      `${t('picker.resumeDecided')} ${resumeStats.decided}/${resumeStats.total}${resumeStatus ? ` · ${resumeStatus}` : ''}`,
                    )
                  : null,
                h(
                  'div',
                  { style: { display: 'flex', gap: 8, marginTop: 2 } },
                  h('button', { type: 'button', style: buttonStyle(true, true), onClick: () => props.onStarted(resume) }, t('picker.resumeContinue')),
                ),
              )
            : null,
          history !== null && history.length > 0
            ? h(
                'div',
                { style: { ...card, display: 'flex', flexDirection: 'column', gap: 6 } },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                  h('span', { style: { fontSize: 12, fontWeight: 600 } }, t('history.title')),
                  h('span', { style: { color: T.secondary, fontSize: 11 } }, String(history.length)),
                ),
                history.slice(0, 5).map((entry) =>
                  h(
                    'div',
                    {
                      key: entry.id,
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        paddingTop: 5,
                        borderTop: `1px solid ${T.border}`,
                      },
                    },
                    h(
                      'div',
                      { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
                      h(
                        'span',
                        {
                          title: entry.source.path,
                          style: { fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                        },
                        entry.source.path,
                      ),
                      h(
                        'span',
                        { style: { fontSize: 11, color: T.secondary } },
                        `${t('picker.resumeDecided')} ${entry.stats.decided}/${entry.stats.total}${entry.active ? ` · ${t('history.current')}` : ''}`,
                      ),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: buttonStyle(false, true),
                        onClick: () => props.onOpenHistory(entry.id, true),
                      },
                      t('history.view'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: buttonStyle(true, true),
                        onClick: () => props.onOpenHistory(entry.id, false),
                      },
                      t('history.continue'),
                    ),
                  ),
                ),
              )
            : null,
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
                { style: { color: T.error, lineHeight: 1.55, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h('span', null, error),
                h(
                  'button',
                  { type: 'button', style: buttonStyle(false, true), onClick: () => setReloadKey((key) => key + 1) },
                  t('picker.retry'),
                ),
              )
            : null,
        ),
        h(
          'div',
          { style: { ...scrollArea, padding: '6px 8px 14px' } },
          files === null
            ? h('div', { style: { padding: '8px 6px' } }, h(LoadingLine, { text: t('picker.loading') }))
            : files.length === 0
              ? h(
                  'div',
                  { style: { color: T.secondary, padding: '8px 6px' } },
                  query === '' ? t('picker.empty') : t('picker.emptyQuery'),
                )
              : h(
                  'ul',
                  { style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
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
                            color: T.primary,
                            font: 'inherit',
                            textAlign: 'left',
                            cursor: busy === '' ? 'pointer' : 'default',
                          },
                          onMouseEnter: (event) => {
                            event.currentTarget.style.background = T.layer1
                            event.currentTarget.style.borderColor = T.border
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
                              color: T.secondary,
                              fontSize: 11,
                              flex: '0 1 auto',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              maxWidth: '55%',
                            },
                          },
                          file.dir === '' ? '.' : file.dir,
                        ),
                        busy === file.path ? h(Spinner, { size: 12 }) : null,
                      ),
                    ),
                  ),
                ),
        ),
      )
    }

    // --- progress -------------------------------------------------------------

    function Progress(props) {
      const stats = props.stats
      const t = props.t
      const pct = stats.total > 0 ? Math.round((stats.decided / stats.total) * 100) : 0
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: T.secondary } },
          h('span', null, `${t('workbench.progress')} ${stats.decided}/${stats.total}`),
          stats.blockingLeft > 0 ? h(Chip, { color: T.error }, `${t('workbench.blockingLeft')} ${stats.blockingLeft}`) : null,
        ),
        h(
          'div',
          { style: { height: 4, borderRadius: 2, background: T.layer2, overflow: 'hidden' } },
          h('div', {
            style: {
              height: '100%',
              width: `${pct}%`,
              background: T.brand,
              borderRadius: 2,
              transition: 'width .25s ease',
            },
          }),
        ),
      )
    }

    // --- decision list --------------------------------------------------------

    function DecisionRow(props) {
      const item = props.item
      const t = props.t
      const selected = props.selected
      return h(
        'button',
        {
          type: 'button',
          role: 'option',
          'aria-selected': selected ? 'true' : 'false',
          onClick: () => props.onSelect(item),
          'aria-current': selected ? 'true' : undefined,
          style: {
            display: 'flex',
            alignItems: 'flex-start',
            gap: 9,
            width: '100%',
            boxSizing: 'border-box',
            padding: '9px 10px',
            borderRadius: 9,
            border: `1px solid ${selected ? T.borderStrong : 'transparent'}`,
            background: selected ? T.layer1 : 'transparent',
            color: T.primary,
            font: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
          },
          onMouseEnter: (event) => {
            if (!selected) event.currentTarget.style.background = T.layer1
          },
          onMouseLeave: (event) => {
            if (!selected) event.currentTarget.style.background = 'transparent'
          },
        },
        h(StatusMark, { status: item.status }),
        h(
          'span',
          { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 } },
          h('span', { style: { fontWeight: 500, lineHeight: 1.4, wordBreak: 'break-word' } }, item.title),
          h(
            'span',
            { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 11, color: T.secondary } },
            h(PriorityChip, { priority: item.priority, t }),
            item.section ? h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150 } }, item.section) : null,
            item.status !== 'unseen'
              ? h('span', { style: { color: item.status === 'decided' ? T.success : item.status === 'unsure' ? T.warn : T.secondary } }, t(`status.${item.status}`))
              : null,
            Array.isArray(item.mergedFrom) && item.mergedFrom.length > 0
              ? h(Chip, { color: T.secondary }, `${t('detail.mergedPrefix')}${item.mergedFrom.length}${t('detail.mergedSuffix')}`)
              : null,
            item.sourceStale === true ? h(Chip, { color: T.warn }, t('detail.sourceStale')) : null,
          ),
        ),
        h('span', { 'aria-hidden': true, style: { color: T.idle, fontSize: 15, lineHeight: '18px', flex: '0 0 auto' } }, '›'),
      )
    }

    function DecisionList(props) {
      const workbench = props.workbench
      const t = props.t
      const items = Array.isArray(props.items) ? props.items : workbench.items
      const stats = props.stats || countItems(workbench.items)
      const filter = props.filter || 'all'
      const filters = [
        { key: 'all', label: t('filter.all'), count: stats.total },
        { key: 'blocking', label: t('priority.blocking'), count: workbench.items.filter((item) => item.priority === 'blocking').length },
        { key: 'open', label: t('filter.open'), count: stats.unseen + stats.unsure + stats.deferred },
        { key: 'decided', label: t('status.decided'), count: stats.decided },
      ]

      const groups = priorityOrder
        .map((priority) => ({ priority, items: items.filter((item) => item.priority === priority) }))
        .filter((group) => group.items.length > 0)

      return h(
        'div',
        { style: { ...scrollArea, padding: '4px 8px 16px' } },
        h(
          'div',
          { style: { display: 'flex', gap: 6, padding: '6px 4px 8px', flexWrap: 'wrap' } },
          filters.map((entry) =>
            h(
              'button',
              {
                key: entry.key,
                type: 'button',
                'aria-pressed': filter === entry.key ? 'true' : 'false',
                onClick: () => props.onFilter(entry.key),
                style: {
                  ...buttonStyle(false, true),
                  borderColor: filter === entry.key ? T.brand : T.border,
                  color: filter === entry.key ? T.brand : T.secondary,
                },
              },
              `${entry.label} ${entry.count}`,
            ),
          ),
        ),
        groups.length === 0
          ? h('div', { style: { color: T.secondary, padding: '10px 6px' } }, t('workbench.empty'))
          : h(
              'div',
              { role: 'listbox', 'aria-label': t('list.title'), style: { display: 'flex', flexDirection: 'column' } },
              groups.map((group) =>
                h(
                  'div',
                  { key: group.priority, role: 'group', 'aria-label': t(`priority.${group.priority}`), style: { marginBottom: 8 } },
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px 2px' } },
                    h('span', { style: { ...sectionTitle, fontSize: 11 } }, t(`priority.${group.priority}`)),
                    h('span', { style: { color: T.secondary, fontSize: 11 } }, String(group.items.length)),
                  ),
                  group.items.map((item) =>
                    h(DecisionRow, {
                      key: item.id,
                      item,
                      t,
                      selected: props.selectedId === item.id,
                      onSelect: props.onSelect,
                    }),
                  ),
                ),
              ),
            ),
      )
    }

    // --- explanation ----------------------------------------------------------

    function ExplanationView(props) {
      const item = props.item
      const t = props.t
      const explanation = item.explanation

      if (item.explanationState === 'loading') {
        return h('div', { style: card }, h(LoadingLine, { text: t('detail.explainLoading') }))
      }
      if (item.explanationState === 'error') {
        return h(
          'div',
          { style: { ...card, borderColor: T.error } },
          h('div', { style: { color: T.error } }, `${t('detail.explainFailed')}${item.explanationError || ''}`),
          props.editable !== false
            ? h(
                'button',
                { type: 'button', style: { ...buttonStyle(false, true), marginTop: 8 }, onClick: props.onRetry },
                t('detail.explainRetry'),
              )
            : null,
        )
      }
      if (!explanation) {
        // Nothing is requested when the item is opened: this card is the only
        // path to an explanation, and it costs one model call when pressed.
        return h(
          'div',
          { style: { ...card, display: 'flex', flexDirection: 'column', gap: 7 } },
          h('div', { style: sectionTitle }, t('detail.explainSection')),
          h('div', { style: { color: T.secondary, fontSize: 12, lineHeight: 1.55 } }, props.editable !== false ? t('detail.explainHint') : t('readOnly.explainHint')),
          props.editable !== false
            ? h(
                'div',
                null,
                h('button', { type: 'button', style: buttonStyle(false), onClick: props.onExplain }, t('detail.explainButton')),
              )
            : null,
        )
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h(
          'div',
          { style: card },
          explanation.gist
            ? h('div', { style: { fontWeight: 600, lineHeight: 1.6, marginBottom: explanation.whyNow || explanation.background ? 8 : 0 } }, explanation.gist)
            : null,
          explanation.whyNow
            ? h('div', { style: { marginBottom: 6 } }, h('div', { style: sectionTitle }, t('detail.whyNow')), h('div', null, explanation.whyNow))
            : null,
          explanation.background
            ? h('div', null, h('div', { style: sectionTitle }, t('detail.background')), h('div', { style: { color: T.primary } }, explanation.background))
            : null,
        ),
        explanation.impact
          ? h('div', { style: card }, h('div', { style: sectionTitle }, t('detail.impact')), h('div', null, explanation.impact))
          : null,
        explanation.assumptions.length > 0
          ? h(
              'div',
              { style: card },
              h('div', { style: { ...sectionTitle, marginBottom: 4 } }, t('detail.assumptions')),
              h(
                'ul',
                { style: { margin: 0, paddingLeft: 18 } },
                explanation.assumptions.map((assumption, index) => h('li', { key: index }, assumption)),
              ),
            )
          : null,
        explanation.citations.length > 0
          ? h(
              'div',
              { style: { ...card, background: 'transparent' } },
              h('div', { style: { ...sectionTitle, marginBottom: 4 } }, t('detail.citations')),
              explanation.citations.map((citation, index) =>
                h(
                  'div',
                  { key: index, style: { fontSize: 12, color: T.secondary, padding: '2px 0' } },
                  h('span', { style: { color: T.brand } }, sourceLabel(citation)),
                  citation.quote ? h('span', null, ` · ${citation.quote}`) : null,
                ),
              ),
            )
          : null,
      )
    }

    /**
     * Concrete examples are a separate, on-demand request. When an older
     * explanation happens to carry scenarios, they are shown here as a
     * read-only fallback instead of being regenerated.
     */
    function ExamplesView(props) {
      const item = props.item
      const t = props.t
      const own = Array.isArray(item.examples) ? item.examples : []
      const fallback = !item.explanation || !Array.isArray(item.explanation.scenarios) ? [] : item.explanation.scenarios
      const examples = own.length > 0 ? own : fallback
      const fromExplain = own.length === 0 && fallback.length > 0
      const state = item.examplesState || 'idle'

      if (state === 'loading') {
        return h('div', { style: card }, h(LoadingLine, { text: t('detail.examplesLoading') }))
      }
      if (state === 'error') {
        return h(
          'div',
          { style: { ...card, borderColor: T.error } },
          h('div', { style: { color: T.error } }, `${t('detail.examplesFailed')}${item.examplesError || ''}`),
          props.editable !== false
            ? h(
                'button',
                { type: 'button', style: { ...buttonStyle(false, true), marginTop: 8 }, onClick: props.onRetry },
                t('detail.examplesRetry'),
              )
            : null,
        )
      }
      if (examples.length === 0) {
        return h(
          'div',
          { style: { ...card, display: 'flex', flexDirection: 'column', gap: 7 } },
          h('div', { style: sectionTitle }, t('detail.examplesSection')),
          h('div', { style: { color: T.secondary, fontSize: 12, lineHeight: 1.55 } }, props.editable !== false ? t('detail.examplesHint') : t('readOnly.examplesHint')),
          props.editable !== false
            ? h(
                'div',
                null,
                h('button', { type: 'button', style: buttonStyle(false), onClick: props.onExamples }, t('detail.examplesButton')),
              )
            : null,
        )
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          h('span', { style: sectionTitle }, t('detail.examplesSection')),
          fromExplain ? h(Chip, { color: T.secondary }, t('detail.examplesFromExplain')) : null,
          props.editable !== false
            ? h(
                'button',
                { type: 'button', style: { ...linkStyle, marginLeft: 'auto' }, onClick: props.onRetry },
                t('detail.examplesRetry'),
              )
            : null,
        ),
        h(
          'div',
          { style: card },
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            examples.map((example, index) =>
              h(
                'div',
                { key: index, style: { display: 'flex', gap: 6, paddingTop: index === 0 ? 0 : 6, borderTop: index === 0 ? 'none' : `1px solid ${T.border}` } },
                h('span', { style: { color: T.secondary, flex: '0 0 auto' } }, t('detail.if')),
                h('span', { style: { flex: '1 1 60%', minWidth: 0 } }, example.if || '—'),
                h('span', { style: { color: T.secondary, flex: '0 0 auto' } }, t('detail.then')),
                h('span', { style: { flex: '1 1 60%', minWidth: 0 } }, example.then || '—'),
              ),
            ),
          ),
        ),
        item.examplesNote ? h('div', { style: { fontSize: 12, color: T.secondary, lineHeight: 1.55 } }, item.examplesNote) : null,
      )
    }

    // --- options --------------------------------------------------------------

    function OptionCard(props) {
      const option = props.option
      const t = props.t
      const selected = props.selected
      const recommended = props.recommended
      return h(
        'button',
        {
          type: 'button',
          role: 'radio',
          'aria-checked': selected ? 'true' : 'false',
          onClick: () => props.onToggle(option.id),
          style: {
            display: 'flex',
            alignItems: 'flex-start',
            gap: 9,
            width: '100%',
            boxSizing: 'border-box',
            padding: '9px 10px',
            borderRadius: 9,
            border: `1px solid ${selected ? T.brand : T.border}`,
            background: selected ? T.layer2 : T.layer1,
            color: T.primary,
            font: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
          },
        },
        h('span', {
          'aria-hidden': true,
          style: {
            width: 14,
            height: 14,
            marginTop: 3,
            borderRadius: '50%',
            border: `2px solid ${selected ? T.brand : T.borderStrong}`,
            background: selected ? T.brand : 'transparent',
            flex: '0 0 auto',
          },
        }),
        h(
          'span',
          { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 } },
          h(
            'span',
            { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
            h('span', { style: { fontWeight: 600, lineHeight: 1.4 } }, option.label),
            recommended ? h(Chip, { color: T.success }, t('detail.recommendation')) : null,
            h(Chip, { color: T.secondary }, option.from === 'assistant' ? t('detail.optionsGenerated') : t('detail.optionsFromSpec')),
          ),
          option.tradeoff ? h('span', { style: { fontSize: 12, color: T.secondary, lineHeight: 1.55 } }, option.tradeoff) : null,
          option.bestWhen ? h('span', { style: { fontSize: 12, color: T.secondary } }, `适合：${option.bestWhen}`) : null,
          option.risk ? h('span', { style: { fontSize: 12, color: T.secondary } }, `风险：${option.risk}`) : null,
        ),
      )
    }

    function OptionsView(props) {
      const item = props.item
      const t = props.t
      const explanation = props.recommendation

      if (item.options.length === 0) {
        if (item.optionsState === 'loading') return h('div', { style: card }, h(LoadingLine, { text: t('detail.generatingOptions') }))
        if (item.optionsState === 'error') {
          return h(
            'div',
            { style: { ...card, borderColor: T.error } },
            h('div', { style: { color: T.error } }, `${t('detail.optionsError')}${item.optionsError || ''}`),
            props.editable !== false
              ? h(
                  'button',
                  { type: 'button', style: { ...buttonStyle(false, true), marginTop: 8 }, onClick: props.onGenerate },
                  t('workbench.retry'),
                )
              : null,
          )
        }
        return h(
          'div',
          { style: { ...card, display: 'flex', flexDirection: 'column', gap: 8 } },
          h('div', { style: { color: T.secondary } }, t('detail.noOptions')),
          props.editable !== false
            ? h(
                'div',
                null,
                h(
                  'button',
                  { type: 'button', style: buttonStyle(false), onClick: props.onGenerate },
                  t('detail.generateOptions'),
                ),
              )
            : null,
        )
      }

      return h(
        'div',
        { role: 'radiogroup', 'aria-label': t('detail.options'), style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        item.options.map((option) =>
          h(OptionCard, {
            key: option.id,
            option,
            t,
            selected: props.selected.includes(option.id),
            recommended: Boolean(explanation && explanation.optionId === option.id),
            onToggle: props.onToggle,
          }),
        ),
        item.optionsState === 'loading' ? h(LoadingLine, { text: t('detail.generatingOptions') }) : null,
        explanation && explanation.why
          ? h(
              'div',
              { style: { ...card, borderColor: T.borderStrong } },
              h('div', { style: { ...sectionTitle, marginBottom: 3 } }, t('detail.recommendation')),
              h('div', null, explanation.why),
            )
          : null,
      )
    }

    // --- ask thread -----------------------------------------------------------

    function ThreadPanel(props) {
      const t = props.t
      const thread = props.thread || []
      const readOnly = props.readOnly === true
      const [draft, setDraft] = React.useState('')
      const [sending, setSending] = React.useState(false)
      const listRef = React.useRef(null)
      const pending = props.threadState === 'loading'

      React.useEffect(() => {
        const element = listRef.current
        if (element) element.scrollTop = element.scrollHeight
      }, [thread.length, props.threadState])

      const send = async (text) => {
        const value = String(text || '').trim()
        if (value === '' || sending || pending) return
        setSending(true)
        setDraft('')
        try {
          await props.onAsk(value)
        } finally {
          setSending(false)
        }
      }

      const suggestions = [t('ask.suggest1'), t('ask.suggest2'), t('ask.suggest3')]

      return h(
        'div',
        { style: { ...card, display: 'flex', flexDirection: 'column', gap: 8 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          h('span', { style: { fontSize: 13, fontWeight: 600 } }, t('ask.title')),
        ),
        h('div', { style: { fontSize: 11, color: T.secondary, lineHeight: 1.5 } }, t('ask.hint')),
        thread.length > 0
          ? h(
              'div',
              { ref: listRef, style: { maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, paddingRight: 2 } },
              thread.map((message) =>
                h(
                  'div',
                  {
                    key: message.id,
                    style: {
                      alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
                      maxWidth: '92%',
                      padding: '6px 9px',
                      borderRadius: 8,
                      background: message.role === 'user' ? T.layer2 : 'transparent',
                      border: message.role === 'user' ? 'none' : `1px solid ${T.border}`,
                      color: message.role === 'assistant' && message.state === 'error' ? T.error : T.primary,
                      fontSize: 12,
                      lineHeight: 1.6,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    },
                  },
                  message.state === 'pending'
                    ? h(LoadingLine, { text: t('ask.pending') })
                    : message.text,
                ),
              ),
            )
          : null,
        thread.length === 0 && !readOnly
          ? h(
              'div',
              { style: { display: 'flex', gap: 5, flexWrap: 'wrap' } },
              suggestions.map((suggestion) =>
                h(
                  'button',
                  { key: suggestion, type: 'button', style: buttonStyle(false, true), onClick: () => send(suggestion) },
                  suggestion,
                ),
              ),
            )
          : null,
        readOnly
          ? null
          : h(
              'div',
              { style: { display: 'flex', gap: 6, alignItems: 'flex-end' } },
          h('textarea', {
            rows: 2,
            value: draft,
            placeholder: t('ask.placeholder'),
            style: { ...inputStyle, resize: 'vertical', lineHeight: 1.5 },
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                send(draft)
              }
            },
          }),
          h(
            'button',
            {
              type: 'button',
              style: { ...buttonStyle(true), flex: '0 0 auto' },
              disabled: draft.trim() === '' || sending || pending,
              onClick: () => send(draft),
            },
            sending || pending ? t('detail.saving') : t('ask.send'),
          ),
        ),
      )
    }

    // --- digest modal ---------------------------------------------------------

    function DigestModal(props) {
      const t = props.t
      const stats = props.stats || {}
      const [writeWanted, setWriteWanted] = React.useState(false)
      const [submitting, setSubmitting] = React.useState(false)
      const [error, setError] = React.useState('')
      const [done, setDone] = React.useState(false)
      const [writePath, setWritePath] = React.useState('')
      const [writeError, setWriteError] = React.useState('')
      const [copied, setCopied] = React.useState(false)

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape' && !submitting) props.onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [props.onClose, submitting])

      const copy = async () => {
        try {
          await navigator.clipboard.writeText(props.digest)
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        } catch {
          setCopied(false)
        }
      }

      const submit = async () => {
        if (submitting) return
        setSubmitting(true)
        setError('')
        try {
          const data = await postJson('/submit', { sessionId: props.sessionId, workbenchId: props.workbenchId })
          setDone(true)
          props.onSubmitted(data.workbench)
          if (writeWanted) {
            try {
              const written = await postJson('/write', { sessionId: props.sessionId, workbenchId: props.workbenchId })
              setWritePath(written.path)
            } catch (failure) {
              setWriteError(String(failure.message || failure))
            }
          }
        } catch (failure) {
          setError(String(failure.message || failure))
        } finally {
          setSubmitting(false)
        }
      }

      const unresolved = (stats.unsure || 0) + (stats.deferred || 0) + (stats.unseen || 0)

      return h(
        'div',
        {
          role: 'presentation',
          style: {
            position: 'absolute',
            inset: 0,
            zIndex: 20,
            background: 'rgba(0,0,0,0.32)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 12,
          },
        },
        h(
          'div',
          {
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('digest.title'),
            style: {
              width: '100%',
              maxWidth: 560,
              maxHeight: '88%',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              background: T.overlay,
              color: T.primary,
              border: `1px solid ${T.borderStrong}`,
              borderRadius: 12,
              padding: 14,
              boxShadow: '0 12px 40px rgba(0,0,0,0.28)',
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { style: { fontSize: 15, fontWeight: 600, flex: 1 } }, t('digest.title')),
            h('button', { type: 'button', style: buttonStyle(false, true), onClick: props.onClose, disabled: submitting }, t('digest.cancel')),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 5, flexWrap: 'wrap' } },
            h(Chip, { color: T.success }, `${t('status.decided')} ${stats.decided || 0}`),
            h(Chip, { color: T.warn }, `${t('status.unsure')} ${stats.unsure || 0}`),
            h(Chip, { color: T.secondary }, `${t('status.deferred')} ${stats.deferred || 0}`),
            h(Chip, { color: T.idle }, `${t('status.unseen')} ${stats.unseen || 0}`),
          ),
          unresolved > 0 ? h('div', { style: { color: T.warn, fontSize: 12, lineHeight: 1.55 } }, t('digest.warning')) : null,
          h(
            'pre',
            {
              style: {
                margin: 0,
                padding: 10,
                borderRadius: 8,
                border: `1px solid ${T.border}`,
                background: T.layer1,
                color: T.primary,
                fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                fontSize: 12,
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                overflowY: 'auto',
                flex: 1,
                minHeight: 120,
              },
            },
            props.digest,
          ),
          done
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                h('div', { style: { color: T.success, display: 'flex', alignItems: 'center', gap: 6 } }, h('span', null, '✓'), t('digest.submitted')),
                writePath !== '' ? h('div', { style: { fontSize: 12, color: T.secondary } }, `${t('notice.written')}${writePath}`) : null,
                writeError !== '' ? h('div', { style: { fontSize: 12, color: T.error } }, `${t('notice.writeFailed')}${writeError}`) : null,
                h(
                  'div',
                  { style: { display: 'flex', justifyContent: 'flex-end' } },
                  h('button', { type: 'button', style: buttonStyle(true), onClick: props.onClose }, t('digest.done')),
                ),
              )
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                error !== '' ? h('div', { style: { color: T.error, fontSize: 12, lineHeight: 1.55 } }, error) : null,
                h(
                  'label',
                  { style: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: T.secondary, cursor: 'pointer' } },
                  h('input', {
                    type: 'checkbox',
                    checked: writeWanted,
                    onChange: (event) => setWriteWanted(event.target.checked),
                  }),
                  t('digest.write'),
                ),
                h(
                  'div',
                  { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' } },
                  h('button', { type: 'button', style: buttonStyle(false, true), onClick: copy }, copied ? t('digest.copied') : t('digest.copy')),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: buttonStyle(true),
                      disabled: submitting,
                      onClick: submit,
                    },
                    submitting ? t('digest.submitting') : t('digest.submit'),
                  ),
                ),
              ),
        ),
      )
    }

    // --- workbench ------------------------------------------------------------

    function WorkbenchView(props) {
      const t = props.t
      const sessionId = props.sessionId
      const workbenchId = props.workbenchId
      const [workbench, setWorkbench] = React.useState(props.initialWorkbench || null)
      const [error, setError] = React.useState('')
      const [selectedId, setSelectedId] = React.useState(null)
      const [filter, setFilter] = React.useState('all')
      const [activeId, setActiveId] = React.useState('')
      const [activated, setActivated] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [digest, setDigest] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [width, setWidth] = React.useState(0)
      const rootRef = React.useRef(null)

      React.useEffect(() => {
        const element = rootRef.current
        if (!element) return undefined
        const update = () => setWidth(element.clientWidth || 0)
        update()
        if (typeof ResizeObserver === 'undefined') {
          window.addEventListener('resize', update)
          return () => window.removeEventListener('resize', update)
        }
        const observer = new ResizeObserver(update)
        observer.observe(element)
        return () => observer.disconnect()
      }, [workbench === null])

      const query = React.useCallback(() => {
        const base = `/workbench?sessionId=${encodeURIComponent(sessionId)}`
        // A fixed id pins the tab to the workbench the user opened, including a
        // read-only history entry; without one the host answers with the
        // workbench active in this session+workspace.
        return workbenchId ? `${base}&workbenchId=${encodeURIComponent(workbenchId)}` : base
      }, [sessionId, workbenchId])

      const applyRemote = React.useCallback(
        (next) => {
          if (!next || typeof next !== 'object') return
          setError('')
          setWorkbench((previous) => {
            if (previous && previous.id === next.id && previous.revision === next.revision) {
              // Polling carries cheap source-health flags (stale/missing) that
              // must land even when the revision is unchanged; everything else
              // is identical, so avoid a needless re-render.
              const before = previous.source || {}
              const after = next.source || {}
              if (before.stale === after.stale && before.missing === after.missing) return previous
              return { ...previous, source: after }
            }
            if (workbenchId && next.id !== workbenchId) return previous
            return next
          })
        },
        [workbenchId],
      )

      const refresh = React.useCallback(async () => {
        try {
          const data = await fetchJson(query())
          if (typeof data.activeId === 'string') setActiveId(data.activeId)
          applyRemote(data.workbench)
        } catch {
          // polling is best effort
        }
      }, [query, applyRemote])

      React.useEffect(() => {
        if (props.active === false) return undefined
        let stopped = false
        let timer = null
        const tick = async () => {
          if (stopped) return
          await refresh()
          if (!stopped) timer = setTimeout(tick, POLL_MS)
        }
        tick()
        return () => {
          stopped = true
          if (timer !== null) clearTimeout(timer)
        }
      }, [refresh, props.active])

      React.useEffect(() => {
        if (workbench !== null) return undefined
        let cancelled = false
        fetchJson(query())
          .then((data) => {
            if (cancelled) return
            if (typeof data.activeId === 'string') setActiveId(data.activeId)
            if (data.workbench) applyRemote(data.workbench)
            else setError(t('workbench.error'))
          })
          .catch((failure) => {
            if (!cancelled) setError(String(failure.message || failure))
          })
        return () => {
          cancelled = true
        }
      }, [query, workbench, applyRemote, t])

      React.useEffect(() => {
        if (!notice) return undefined
        const timer = setTimeout(() => setNotice(null), 6000)
        return () => clearTimeout(timer)
      }, [notice])

      const patchItem = (nextItem) => {
        if (!nextItem) return
        setWorkbench((previous) => {
          if (!previous) return previous
          return { ...previous, items: previous.items.map((item) => (item.id === nextItem.id ? nextItem : item)) }
        })
      }

      const post = async (path, body) => {
        if (!workbench) return null
        setBusy(path)
        try {
          return await postJson(path, { sessionId, workbenchId: workbench.id, ...body })
        } finally {
          setBusy('')
        }
      }

      const report = (failure, prefixKey) => {
        setNotice({ kind: 'error', text: `${prefixKey ? t(prefixKey) : ''}${String(failure.message || failure)}` })
      }

      const openItem = (item) => {
        setSelectedId(item.id)
        postJson('/item', { sessionId, workbenchId: workbench.id, itemId: item.id }).catch(() => {})
      }

      const selectedItem = workbench && selectedId ? workbench.items.find((item) => item.id === selectedId) : null

      // Wide panes keep the designed two-column workbench (list left, detail
      // right). A narrow pane falls back to list → detail navigation. The
      // split opens on the first unresolved decision so the panel is never a
      // blank right half.
      React.useEffect(() => {
        if (!workbench || workbench.items.length === 0) return
        if (selectedId !== null && !workbench.items.some((item) => item.id === selectedId)) {
          setSelectedId(null)
          return
        }
        if (width < SPLIT_MIN_WIDTH || selectedId !== null) return
        const first = workbench.items.find((item) => item.status === 'unseen') || workbench.items[0]
        setSelectedId(first.id)
        postJson('/item', { sessionId, workbenchId: workbench.id, itemId: first.id }).catch(() => {})
      }, [workbench, selectedId, width, sessionId])

      // Nothing is generated when an item opens. Explanation and examples are
      // explicit requests, so scrolling through the list costs zero tokens.
      const editable = !props.readOnly || activated || (workbench !== null && activeId !== '' && activeId === workbench.id)

      const visibleItems = React.useMemo(() => {
        if (!workbench) return []
        return workbench.items.filter((item) => {
          if (filter === 'blocking') return item.priority === 'blocking'
          if (filter === 'open') return item.status !== 'decided'
          if (filter === 'decided') return item.status === 'decided'
          return true
        })
      }, [workbench, filter])

      const orderedIds = React.useMemo(
        () => priorityOrder.flatMap((priority) => visibleItems.filter((item) => item.priority === priority).map((item) => item.id)),
        [visibleItems],
      )

      const moveSelection = React.useCallback(
        (step) => {
          if (!workbench || orderedIds.length === 0) return
          const index = selectedId === null ? -1 : orderedIds.indexOf(selectedId)
          const nextIndex =
            index < 0 ? (step > 0 ? 0 : orderedIds.length - 1) : Math.max(0, Math.min(orderedIds.length - 1, index + step))
          const nextId = orderedIds[nextIndex]
          if (!nextId || nextId === selectedId) return
          const item = workbench.items.find((entry) => entry.id === nextId)
          if (!item) return
          setSelectedId(item.id)
          postJson('/item', { sessionId, workbenchId: workbench.id, itemId: item.id }).catch(() => {})
        },
        [workbench, orderedIds, selectedId, sessionId],
      )

      const onKeyDown = (event) => {
        const target = event.target
        const tag = target && typeof target.tagName === 'string' ? target.tagName : ''
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (target && target.isContentEditable === true)) return
        if (event.key === 'Escape') {
          if (digest) {
            setDigest(null)
            event.preventDefault()
          } else if (selectedId !== null) {
            setSelectedId(null)
            event.preventDefault()
          }
          return
        }
        if (event.key === 'j' || event.key === 'J' || event.key === 'ArrowDown') {
          moveSelection(1)
          event.preventDefault()
        } else if (event.key === 'k' || event.key === 'K' || event.key === 'ArrowUp') {
          moveSelection(-1)
          event.preventDefault()
        }
      }

      const requestExplain = async (force) => {
        if (!selectedItem) return
        try {
          const data = await post('/explain', { itemId: selectedItem.id, force: force === true })
          if (data && data.item) patchItem(data.item)
        } catch (failure) {
          report(failure, 'notice.explainFailed')
        }
      }

      const requestExamples = async (force) => {
        if (!selectedItem) return
        try {
          const data = await post('/examples', { itemId: selectedItem.id, force: force === true })
          if (data && data.item) patchItem(data.item)
        } catch (failure) {
          report(failure, 'notice.examplesFailed')
        }
      }

      const resync = async () => {
        if (!workbench) return
        setBusy('resync')
        try {
          const data = await postJson('/resync', { sessionId, workbenchId: workbench.id })
          if (data.workbench) setWorkbench(data.workbench)
          const stale = Array.isArray(data.staleItems) ? data.staleItems.length : 0
          setNotice({
            kind: stale > 0 ? 'error' : 'success',
            text:
              stale > 0
                ? `${t('workbench.resyncedStalePrefix')}${stale}${t('workbench.resyncedStaleSuffix')}`
                : t('workbench.resyncedOk'),
          })
        } catch (failure) {
          report(failure, 'notice.resyncFailed')
        } finally {
          setBusy('')
        }
      }

      const continueEditing = async () => {
        if (!workbench) return
        setBusy('activate')
        try {
          const data = await postJson('/activate', { sessionId, workbenchId: workbench.id })
          if (data.workbench) setWorkbench(data.workbench)
          if (typeof data.workbench?.id === 'string') setActiveId(data.workbench.id)
          setActivated(true)
        } catch (failure) {
          report(failure, 'notice.activateFailed')
        } finally {
          setBusy('')
        }
      }

      const decide = async (status, itemOverride) => {
        const item = itemOverride || selectedItem
        if (!item) return
        const optionIds = status === 'decided' ? decisionDraft.optionIds : []
        const custom = status === 'decided' ? decisionDraft.custom.trim() : ''
        if (status === 'decided' && optionIds.length === 0 && custom === '') {
          setNotice({ kind: 'error', text: t('detail.chooseFirst') })
          return
        }
        try {
          const data = await post('/decide', {
            itemId: item.id,
            status,
            optionIds,
            custom,
            rationale: decisionDraft.rationale.trim(),
          })
          if (data && data.item) patchItem(data.item)
          setNotice({ kind: 'success', text: status === 'decided' ? t('detail.saved') : '' })
          if (status === 'decided') {
            const next = workbench.items.find((entry) => entry.id !== item.id && entry.status === 'unseen')
            if (next) setSelectedId(next.id)
          }
        } catch (failure) {
          report(failure, 'notice.decideFailed')
        }
      }

      const [decisionDraft, setDecisionDraft] = React.useState({ optionIds: [], custom: '', rationale: '' })

      React.useEffect(() => {
        if (!selectedItem) {
          setDecisionDraft({ optionIds: [], custom: '', rationale: '' })
          return
        }
        setDecisionDraft({
          optionIds: selectedItem.decision && Array.isArray(selectedItem.decision.optionIds) ? selectedItem.decision.optionIds : [],
          custom: (selectedItem.decision && selectedItem.decision.custom) || '',
          rationale: (selectedItem.decision && selectedItem.decision.rationale) || '',
        })
      }, [selectedItem && selectedItem.id, selectedItem && selectedItem.decision && selectedItem.decision.at])

      const toggleOption = (optionId) => {
        setDecisionDraft((previous) => {
          const selected = previous.optionIds.includes(optionId)
          return { ...previous, optionIds: selected ? [] : [optionId] }
        })
      }

      const ask = async (text) => {
        if (!selectedItem) return
        try {
          const data = await post('/ask', { itemId: selectedItem.id, text })
          if (data && data.item) patchItem(data.item)
        } catch (failure) {
          report(failure, 'notice.askFailed')
        }
      }

      const generateOptions = async () => {
        if (!selectedItem) return
        try {
          const data = await post('/options', { itemId: selectedItem.id })
          if (data && data.item) patchItem(data.item)
        } catch (failure) {
          report(failure, 'notice.optionsFailed')
        }
      }

      const openDigest = async () => {
        if (!workbench) return
        setBusy('preview')
        try {
          const data = await postJson('/preview', { sessionId, workbenchId: workbench.id })
          setDigest({ text: data.digest, stats: data.stats })
        } catch (failure) {
          report(failure, 'notice.submitFailed')
        } finally {
          setBusy('')
        }
      }

      const regenerate = async () => {
        if (!workbench) return
        setBusy('start')
        try {
          const data = await postJson('/start', {
            sessionId,
            path: workbench.source.path,
            restart: true,
          })
          setSelectedId(null)
          setWorkbench(data.workbench)
        } catch (failure) {
          report(failure, 'notice.openFailed')
        } finally {
          setBusy('')
        }
      }

      if (error !== '' && !workbench) {
        return h(
          'div',
          { style: { ...surface, padding: 16, gap: 8 } },
          h('div', { style: { color: T.error } }, t('workbench.error')),
          h('div', { style: { color: T.secondary } }, error),
          h(
            'div',
            null,
            h('button', { type: 'button', style: buttonStyle(false), onClick: () => refresh() }, t('workbench.retry')),
          ),
        )
      }

      if (!workbench) {
        return h('div', { style: { ...surface, padding: 16 } }, h(LoadingLine, { text: t('workbench.loading') }))
      }

      const stats = countItems(workbench.items)
      const generating = workbench.status === 'generating'
      const failed = workbench.status === 'failed'
      const split = width >= SPLIT_MIN_WIDTH
      const header = h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: '12px 14px 10px',
            borderBottom: `1px solid ${T.border}`,
            flex: '0 0 auto',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'flex-start', gap: 8 } },
          h(
            'div',
            { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
            h(
              'div',
              { style: { fontSize: 14, fontWeight: 600, lineHeight: 1.4, wordBreak: 'break-word' } },
              workbench.title || workbench.source.path,
            ),
            h('div', { style: { fontSize: 11, color: T.secondary, wordBreak: 'break-all' } }, workbench.source.path),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 6, flex: '0 0 auto' } },
            h('button', { type: 'button', style: buttonStyle(false, true), onClick: openDigest, disabled: busy !== '' }, t('workbench.summary')),
            h('button', { type: 'button', style: buttonStyle(false, true), onClick: props.onChooseAnother }, t('workbench.chooseAnother')),
          ),
        ),
        workbench.status === 'submitted'
          ? h(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 8px',
                  borderRadius: 8,
                  border: `1px solid ${T.success}`,
                  color: T.success,
                  fontSize: 12,
                  lineHeight: 1.5,
                },
              },
              h('span', { style: { flex: 1 } }, t('submitted.banner')),
            )
          : null,
        props.readOnly && !editable
          ? h(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 8px',
                  borderRadius: 8,
                  border: `1px solid ${T.borderStrong}`,
                  color: T.secondary,
                  fontSize: 12,
                  lineHeight: 1.5,
                },
              },
              h('span', { style: { flex: 1 } }, t('readOnly.banner')),
              h(
                'button',
                { type: 'button', style: buttonStyle(true, true), onClick: continueEditing, disabled: busy !== '' },
                t('readOnly.continue'),
              ),
            )
          : null,
        workbench.source.missing === true || workbench.source.stale === true
          ? h(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 8px',
                  borderRadius: 8,
                  border: `1px solid ${T.warn}`,
                  color: T.warn,
                  fontSize: 12,
                  lineHeight: 1.5,
                },
              },
              h('span', { style: { flex: 1 } }, workbench.source.missing === true ? t('workbench.missing') : t('workbench.stale')),
              workbench.source.missing === true || !editable
                ? null
                : h(
                    'button',
                    { type: 'button', style: buttonStyle(false, true), onClick: resync, disabled: busy !== '' },
                    busy === 'resync' ? t('workbench.resyncing') : t('workbench.resync'),
                  ),
            )
          : null,
        h(Progress, { stats, t }),
      )

      let body = null
      if (generating) {
        body = h(
          'div',
          { style: { ...scrollArea, display: 'flex', flexDirection: 'column', gap: 10, padding: '18px 16px' } },
          h(LoadingLine, { text: t('workbench.generating') }),
          h('div', { style: { color: T.secondary, fontSize: 12 } }, t('workbench.generatingHint')),
        )
      } else if (failed) {
        body = h(
          'div',
          { style: { ...scrollArea, padding: '16px 14px', display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', { style: { color: T.error, fontWeight: 600 } }, t('workbench.failed')),
          h(
            'div',
            {
              style: {
                ...card,
                borderColor: T.error,
                color: T.primary,
                fontSize: 12,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              },
            },
            workbench.error || '',
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8 } },
            h(
              'button',
              { type: 'button', style: buttonStyle(true), onClick: regenerate, disabled: busy !== '' },
              t('workbench.regenerate'),
            ),
            h('button', { type: 'button', style: buttonStyle(false), onClick: props.onChooseAnother }, t('workbench.chooseAnother')),
          ),
        )
      } else if (workbench.items.length === 0) {
        body = h(
          'div',
          { style: { ...scrollArea, padding: '24px 16px', display: 'flex', flexDirection: 'column', gap: 8 } },
          h('div', { style: { fontWeight: 600 } }, t('workbench.empty')),
          h('div', { style: { color: T.secondary } }, t('workbench.emptyHint')),
          h(
            'div',
            null,
            h('button', { type: 'button', style: buttonStyle(false), onClick: props.onChooseAnother }, t('workbench.chooseAnother')),
          ),
        )
      } else {
        const detail = selectedItem
          ? h(
              'div',
              { style: { ...scrollArea, padding: '10px 14px 20px', display: 'flex', flexDirection: 'column', gap: 10 } },
              split
                ? null
                : h(
                    'button',
                    { type: 'button', style: { ...linkStyle, alignSelf: 'flex-start' }, onClick: () => setSelectedId(null) },
                    `‹ ${t('detail.back')}`,
                  ),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
              h(PriorityChip, { priority: selectedItem.priority, t }),
              h(StatusMark, { status: selectedItem.status }),
              h('span', { style: { fontSize: 12, color: T.secondary } }, t(`status.${selectedItem.status}`)),
              Array.isArray(selectedItem.mergedFrom) && selectedItem.mergedFrom.length > 0
                ? h(Chip, { color: T.secondary }, `${t('detail.mergedPrefix')}${selectedItem.mergedFrom.length}${t('detail.mergedSuffix')}`)
                : null,
              selectedItem.sourceStale === true ? h(Chip, { color: T.warn }, t('detail.sourceStale')) : null,
            ),
            h('div', { style: { fontSize: 16, fontWeight: 600, lineHeight: 1.4, wordBreak: 'break-word' } }, selectedItem.title),
          ),
          h(
            'div',
            { style: { ...card, borderLeft: `3px solid ${T.brand}` } },
            h('div', { style: sectionTitle }, t('detail.question')),
            h('div', { style: { fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' } }, selectedItem.question),
          ),
          selectedItem.source && (selectedItem.source.quote || selectedItem.source.line)
            ? h(
                'div',
                { style: { ...card, background: 'transparent', fontSize: 12, color: T.secondary } },
                h('div', { style: sectionTitle }, t('detail.source')),
                h(
                  'div',
                  { style: { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' } },
                  h('span', { style: { color: T.brand } }, sourceLabel(selectedItem.source)),
                ),
                selectedItem.source.quote ? h('div', { style: { marginTop: 3, color: T.primary, fontStyle: 'italic' } }, `“${selectedItem.source.quote}”`) : null,
              )
            : null,
          h(ExplanationView, {
            item: selectedItem,
            t,
            editable,
            onExplain: () => requestExplain(false),
            onRetry: () => requestExplain(true),
          }),
          h(ExamplesView, {
            item: selectedItem,
            t,
            editable,
            onExamples: () => requestExamples(false),
            onRetry: () => requestExamples(true),
          }),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 6 } },
              h('span', { style: { ...sectionTitle } }, t('detail.options')),
              selectedItem.optionsOrigin === 'generated' ? h(Chip, { color: T.secondary }, t('detail.optionsGenerated')) : null,
            ),
            h(OptionsView, {
              item: selectedItem,
              t,
              editable,
              selected: decisionDraft.optionIds,
              recommendation: selectedItem.recommendation,
              onToggle: editable ? toggleOption : () => {},
              onGenerate: generateOptions,
            }),
          ),
          h(
            'div',
            { style: { ...card, display: 'flex', flexDirection: 'column', gap: 6 } },
            h('div', { style: sectionTitle }, t('detail.custom')),
            editable
              ? h('textarea', {
                  rows: 2,
                  value: decisionDraft.custom,
                  placeholder: t('detail.customPlaceholder'),
                  style: { ...inputStyle, resize: 'vertical', lineHeight: 1.5 },
                  onChange: (event) => setDecisionDraft((previous) => ({ ...previous, custom: event.target.value })),
                })
              : h('div', { style: { whiteSpace: 'pre-wrap' } }, (selectedItem.decision && selectedItem.decision.custom) || '—'),
          ),
          h(
            'div',
            { style: { ...card, display: 'flex', flexDirection: 'column', gap: 6 } },
            h('div', { style: sectionTitle }, t('detail.rationale')),
            editable
              ? h('textarea', {
                  rows: 2,
                  value: decisionDraft.rationale,
                  placeholder: t('detail.rationalePlaceholder'),
                  style: { ...inputStyle, resize: 'vertical', lineHeight: 1.5 },
                  onChange: (event) => setDecisionDraft((previous) => ({ ...previous, rationale: event.target.value })),
                })
              : h('div', { style: { whiteSpace: 'pre-wrap' } }, (selectedItem.decision && selectedItem.decision.rationale) || '—'),
          ),
          editable
            ? h(
                'div',
                { style: { display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' } },
                h(
                  'button',
                  {
                    type: 'button',
                    style: buttonStyle(true),
                    disabled: busy !== '' || (decisionDraft.optionIds.length === 0 && decisionDraft.custom.trim() === ''),
                    onClick: () => decide('decided'),
                  },
                  t('detail.decide'),
                ),
                h('button', { type: 'button', style: buttonStyle(false), disabled: busy !== '', onClick: () => decide('unsure') }, t('detail.unsure')),
                h('button', { type: 'button', style: buttonStyle(false), disabled: busy !== '', onClick: () => decide('deferred') }, t('detail.deferred')),
                selectedItem.status !== 'unseen'
                  ? h('button', { type: 'button', style: linkStyle, disabled: busy !== '', onClick: () => decide('unseen') }, t('detail.clear'))
                  : null,
                selectedItem.status === 'decided' && decisionText(selectedItem) !== ''
                  ? h('span', { style: { color: T.success, fontSize: 12 } }, `${t('detail.saved')}：${decisionText(selectedItem)}`)
                  : null,
              )
            : selectedItem.status === 'decided' && decisionText(selectedItem) !== ''
              ? h('div', { style: { color: T.success, fontSize: 12 } }, `${t('detail.saved')}：${decisionText(selectedItem)}`)
              : null,
          h(ThreadPanel, {
            key: selectedItem.id,
            t,
            readOnly: !editable,
            thread: selectedItem.thread,
            threadState: selectedItem.threadState,
            onAsk: ask,
          }),
            )
          : null

        if (split) {
          const leftWidth = Math.max(176, Math.min(250, Math.round(width * 0.36)))
          body = h(
            'div',
            { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row' } },
            h(
              'div',
              {
                style: {
                  width: leftWidth,
                  flex: `0 0 ${leftWidth}px`,
                  minHeight: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  borderRight: `1px solid ${T.border}`,
                },
              },
              h(
                'div',
                { style: { padding: '8px 10px 0', fontSize: 12, fontWeight: 600, color: T.secondary } },
                t('list.title'),
              ),
              h(DecisionList, {
                workbench,
                t,
                items: visibleItems,
                stats,
                filter,
                onFilter: setFilter,
                selectedId,
                onSelect: openItem,
              }),
            ),
            h(
              'div',
              { style: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' } },
              detail !== null
                ? detail
                : h('div', { style: { ...scrollArea, padding: 24, color: T.secondary } }, t('detail.empty')),
            ),
          )
        } else if (detail !== null) {
          body = detail
        } else {
          body = h(DecisionList, {
            workbench,
            t,
            items: visibleItems,
            stats,
            filter,
            onFilter: setFilter,
            selectedId,
            onSelect: openItem,
          })
        }
      }

      const footer =
        !generating && !failed && workbench.items.length > 0
          ? h(
              'div',
              {
                style: {
                  flex: '0 0 auto',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 14px',
                  borderTop: `1px solid ${T.border}`,
                  background: T.base,
                },
              },
              h('div', { style: { flex: 1, minWidth: 0, fontSize: 11, color: T.secondary } }, `${t('workbench.progress')} ${stats.decided}/${stats.total}`),
              editable
                ? h(
                    'button',
                    { type: 'button', style: buttonStyle(true, true), onClick: openDigest, disabled: busy !== '' },
                    t('digest.submit'),
                  )
                : null,
            )
          : null

      return h(
        React.Fragment,
        null,
        h('style', { key: 'dsw-dw-keyframes' }, KEYFRAMES),
        h(
          'div',
          { ref: rootRef, style: surface, tabIndex: -1, onKeyDown, 'aria-label': t('tab.title') },
          header,
          notice !== null
            ? h(
                'div',
                {
                  role: 'status',
                  style: {
                    margin: '8px 12px 0',
                    padding: '6px 9px',
                    borderRadius: 7,
                    fontSize: 12,
                    lineHeight: 1.5,
                    border: `1px solid ${notice.kind === 'error' ? T.error : notice.kind === 'success' ? T.success : T.border}`,
                    color: notice.kind === 'error' ? T.error : notice.kind === 'success' ? T.success : T.primary,
                    wordBreak: 'break-word',
                  },
                },
                notice.text,
              )
            : null,
          body,
          footer,
          digest !== null
            ? h(DigestModal, {
                t,
                sessionId,
                workbenchId: workbench.id,
                digest: digest.text,
                stats: digest.stats,
                onClose: () => setDigest(null),
                onSubmitted: (nextWorkbench) => {
                  if (nextWorkbench) setWorkbench(nextWorkbench)
                },
              })
            : null,
        ),
      )
    }

    // --- tab body -------------------------------------------------------------

    // A language switch bumps the locale revision. Bound `t` already reads the
    // active locale at call time, but nothing would re-render the tree, so this
    // hook subscribes and forces one render pass.
    function useLocaleTick(locale) {
      const [, setRevision] = React.useState(0)
      React.useEffect(() => {
        if (!locale || typeof locale.subscribe !== 'function') return undefined
        return locale.subscribe(() => setRevision((value) => value + 1))
      }, [locale])
    }

    function TabBody(props) {
      const t = props.t
      useLocaleTick(props.locale)
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : null
      const params = (info && info.tab && info.tab.navigation && info.tab.navigation.params) || {}
      const [mode, setMode] = React.useState(params.mode === 'workbench' ? 'workbench' : 'pick')
      const [workbenchId, setWorkbenchId] = React.useState(typeof params.workbenchId === 'string' ? params.workbenchId : '')
      const [readOnly, setReadOnly] = React.useState(params.readOnly === true)
      const [started, setStarted] = React.useState(null)

      React.useEffect(() => {
        if (params.mode === 'workbench') {
          setMode('workbench')
          setStarted(null)
          setReadOnly(params.readOnly === true)
          if (typeof params.workbenchId === 'string') setWorkbenchId(params.workbenchId)
        } else if (params.mode === 'pick') {
          setMode('pick')
          setStarted(null)
          setReadOnly(false)
        }
      }, [params.mode, params.workbenchId, params.readOnly])

      const active = !info || !info.tab || info.tab.visible !== false
      const sessionId = props.sessionId

      const openHistory = (id, viewOnly) => {
        setStarted(null)
        setWorkbenchId(id)
        setReadOnly(viewOnly === true)
        setMode('workbench')
      }

      const content =
        mode === 'workbench'
          ? h(WorkbenchView, {
              key: started ? started.id : workbenchId || 'active',
              t,
              sessionId,
              workbenchId: started ? started.id : workbenchId,
              initialWorkbench: started,
              readOnly,
              active,
              onChooseAnother: () => {
                setStarted(null)
                setMode('pick')
              },
            })
          : h(FilePicker, {
              t,
              sessionId,
              onOpenHistory: openHistory,
              onStarted: (workbench) => {
                setStarted(workbench)
                setWorkbenchId(workbench.id)
                setReadOnly(false)
                setMode('workbench')
              },
            })

      return h(React.Fragment, null, h('style', { key: 'dsw-dw-keyframes' }, KEYFRAMES), content)
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
        ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, (props) =>
          h(TabBody, { ...props, t, locale: ctx.get('locale') }),
        ),
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
