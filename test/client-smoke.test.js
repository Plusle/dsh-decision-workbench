// Smoke test for the browser half. It runs the bundle factory and apply() with
// a minimal fake client context, which catches module-level mistakes (bad
// references, malformed registrations) without a browser or a real React.
//
// It deliberately does not render components: rendering is what the page
// verification covers manually.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

function fakeReact() {
  const pass = (value) => value
  return {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, pass],
    useEffect: () => undefined,
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useSyncExternalStore: () => undefined,
  }
}

test('the client bundle loads and registers the tab + listener', async () => {
  const loaded = []
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        loaded.push(definition)
      },
    },
  }
  await import('../src/client.js')

  assert.equal(loaded.length, 1, 'exactly one module is registered')
  const definition = loaded[0]
  assert.equal(definition.id, 'dsh-decision-workbench')
  assert.equal(typeof definition.factory, 'function')

  const exports = definition.factory((id) => {
    assert.equal(id, 'react')
    return fakeReact()
  })
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'])

  const effects = []
  const tabTypes = []
  const slotRegistrations = []
  let dictionaryRegistration = null
  const ctx = {
    effect(fn) {
      const disposer = fn()
      effects.push(typeof disposer)
      return () => {}
    },
    locale: {
      bind: () => (key) => key,
      register: (namespace, dictionaries) => {
        dictionaryRegistration = { namespace, dictionaries }
        return () => {}
      },
    },
    sidebarRightTabs: {
      register: (definitionToRegister) => {
        tabTypes.push(definitionToRegister)
        return () => {}
      },
    },
    slots: {
      inject(key, callback) {
        callback()
        return () => {}
      },
      register(selector, component) {
        slotRegistrations.push({ selector, component })
        return () => {}
      },
    },
    get: () => undefined,
  }

  exports.apply(ctx)

  assert.equal(dictionaryRegistration.namespace, 'dsh-decision-workbench')
  assert.ok(dictionaryRegistration.dictionaries.zh['tab.title'])
  assert.ok(dictionaryRegistration.dictionaries.en['tab.title'])
  assert.ok(dictionaryRegistration.dictionaries.zh['digest.autoRead'])
  assert.ok(dictionaryRegistration.dictionaries.en['digest.autoRead'])
  assert.ok(dictionaryRegistration.dictionaries.zh['digest.resolution'])
  assert.ok(dictionaryRegistration.dictionaries.zh['picker.searchHint'])
  assert.ok(dictionaryRegistration.dictionaries.zh['history.deleteTitle'])

  assert.equal(tabTypes.length, 1)
  assert.equal(tabTypes[0].id, 'dsh-decision-workbench/workbench')
  assert.equal(tabTypes[0].kind, 'decision-workbench')
  assert.equal(tabTypes[0].keepMounted, true)
  assert.equal(typeof tabTypes[0].title, 'function')

  const slotNames = slotRegistrations.map((entry) => entry.selector.name)
  assert.deepEqual(slotNames, [
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab.title',
    'conversation.composer.dock',
  ])
  for (const entry of slotRegistrations) assert.equal(typeof entry.component, 'function')
  // Dictionaries + tab type.
  assert.deepEqual(effects, ['function', 'function'])

  delete globalThis.window
})

// `--dsw-alias-brand-primary` is an INK token: near-black in the light theme,
// near-white in the dark one. It must never fill a primary button, and the
// label must not be a hardcoded #fff, or the dark theme renders white-on-white.
test('workbench deletion uses an in-panel confirmation, not a native dialog', async () => {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /window\.confirm/)
  assert.match(source, /history\.deleteTitle/)
  assert.match(source, /deleteTarget !== null/)
})

test('file picker keyboard selection is wired', async () => {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')

  assert.match(source, /onKeyDown: onSearchKeyDown/)
  assert.match(source, /ArrowDown/)
  assert.match(source, /ArrowUp/)
  assert.match(source, /lastFileSignatureRef/)
  assert.match(source, /aria-activedescendant/)
})

test('primary buttons use the themed filled-button pair', async () => {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')

  assert.match(source, /--dsw-alias-button-primary-fill/)
  assert.match(source, /--dsw-alias-label-primary-foreground/)
  assert.doesNotMatch(source, /background:\s*primary\s*\?\s*T\.brand\b/)
  assert.doesNotMatch(source, /color:\s*primary\s*\?\s*'#ffffff'/)
})
