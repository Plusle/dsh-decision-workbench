// Smoke test for the browser half. It runs the bundle factory and apply() with
// a minimal fake client context, which catches module-level mistakes (bad
// references, malformed registrations) without a browser or a real React.
//
// It deliberately does not render components: rendering is what the page
// verification covers manually.
import test from 'node:test'
import assert from 'node:assert/strict'

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
  // Dictionaries + tab type are the two ctx.effect registrations.
  assert.deepEqual(effects, ['function', 'function'])

  delete globalThis.window
})
