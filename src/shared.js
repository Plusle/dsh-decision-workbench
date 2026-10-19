// dsh-decision-workbench - pure helpers shared by the host half and its tests.
//
// Nothing here touches the Cordis context, the filesystem, or the network, so
// the command parser and the path rules can be tested without a Harness
// process.
import { isAbsolute, relative, sep } from 'node:path'

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
