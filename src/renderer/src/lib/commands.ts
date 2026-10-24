/**
 * Keyboard command registry of the renderer: the live keymap (defaults + Settings → Shortcuts), the
 * window-level dispatcher for app and tab shortcuts, matchers for focused widgets and CodeMirror editors,
 * and labels for tooltips and menus.
 */
import { useEffect, useRef } from 'react'
import { Prec } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { keymap as cmKeymap } from '@codemirror/view'
import type { EditorView } from '@codemirror/view'
import { COMMANDS } from '@shared/commands'
import type { CommandId } from '@shared/commands'
import { buildKeyIndex, commandsForKey, effectiveKeymap, eventIdentity, isTypingCombo, keyLabel, platformOf } from '@shared/keymap'
import type { Keymap, Platform } from '@shared/keymap'
import { useStore } from '../state/store'

export type { CommandId }

export const platform: Platform = platformOf(window.bridge.platform)

// ---------------------------------------------------------------------------
// Live keymap
// ---------------------------------------------------------------------------

let overrides: Keymap | undefined
let keymap: Keymap = effectiveKeymap(COMMANDS, {})
let index = buildKeyIndex(COMMANDS, keymap, platform)

/**
 * Rebuild the lookup tables when the saved overrides changed. Called lazily by every reader (the store is
 * not read at module load: the store module imports dialogs, which import this module).
 */
function sync(): void {
  const next = useStore.getState().settings.keymap
  if (next === overrides) return
  overrides = next
  keymap = effectiveKeymap(COMMANDS, next ?? {})
  index = buildKeyIndex(COMMANDS, keymap, platform)
}

/** Current bindings of a command (portable notation). */
export const bindingsOf = (id: CommandId): string[] => {
  sync()
  return keymap[id] ?? []
}

/** Command ids bound to the pressed keys, innermost scope first. */
export function commandsForEvent(e: KeyboardEvent): CommandId[] {
  sync()
  const identity = eventIdentity(e)
  return identity ? (commandsForKey(COMMANDS, index, identity) as CommandId[]) : []
}

/** Whether the event is one of the command's shortcuts. */
export const matches = (e: KeyboardEvent, id: CommandId): boolean => commandsForEvent(e).includes(id)

/** The first of `ids` (in the given order) that the event triggers, or null. */
export function matchCommand<T extends CommandId>(e: KeyboardEvent, ids: readonly T[]): T | null {
  const hit = commandsForEvent(e)
  if (!hit.length) return null
  return ids.find((id) => hit.includes(id)) ?? null
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** Label of the command's first shortcut ("Ctrl+Enter", "⌘↩"), or '' when it has none. */
export function shortcutLabel(id: CommandId): string {
  const k = bindingsOf(id)[0]
  return k ? keyLabel(k, platform) : ''
}

/** "Run query (Ctrl+Enter)", or just the text when the command has no shortcut. */
export function withShortcut(text: string, id: CommandId): string {
  const k = shortcutLabel(id)
  return k ? `${text} (${k})` : text
}

/** "Run (Ctrl+Enter or F5)": every shortcut of the command. */
export function withShortcuts(text: string, id: CommandId): string {
  const keys = bindingsOf(id).map((k) => keyLabel(k, platform))
  return keys.length ? `${text} (${keys.join(' or ')})` : text
}

/** shortcutLabel() that re-renders the component when the keymap changes. */
export function useShortcut(id: CommandId): string {
  useStore((s) => s.settings.keymap)
  return shortcutLabel(id)
}

// ---------------------------------------------------------------------------
// Shortcut recorder (Settings → Shortcuts)
// ---------------------------------------------------------------------------

let recording = 0

/** While a shortcut is being recorded, no command runs and dialogs ignore Escape. */
export function setRecording(on: boolean): void {
  recording = Math.max(0, recording + (on ? 1 : -1))
}
export const isRecording = (): boolean => recording > 0

// ---------------------------------------------------------------------------
// Window-level dispatcher (app and tab shortcuts)
// ---------------------------------------------------------------------------

/** Return false when the command does not apply right now (the key then goes on as usual). */
export type CommandHandler = (e: KeyboardEvent) => boolean | void
export type CommandHandlers = Partial<Record<CommandId, CommandHandler>>

const registrations: { readonly current: CommandHandlers }[] = []

/**
 * Handle commands while `enabled` (e.g. while the tab is the active one). Later registrations win over
 * earlier ones; handlers can change between renders.
 */
export function useCommandHandlers(enabled: boolean, handlers: CommandHandlers): void {
  const ref = useRef(handlers)
  ref.current = handlers
  useEffect(() => {
    if (!enabled) return
    registrations.push(ref)
    return () => {
      const i = registrations.indexOf(ref)
      if (i >= 0) registrations.splice(i, 1)
    }
  }, [enabled])
}

function isEditable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable) return true
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true
  return t instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(t.type)
}

function dispatch(e: KeyboardEvent): void {
  // Already handled by a focused widget or editor (which use the same keymap), or a dialog is open.
  if (e.defaultPrevented || e.isComposing || isRecording() || document.querySelector('.modal')) return
  const identity = eventIdentity(e)
  if (!identity) return
  sync()
  const ids = commandsForKey(COMMANDS, index, identity) as CommandId[]
  if (!ids.length) return
  // Plain typing keys stay with text fields.
  if (isEditable(e.target) && isTypingCombo(identity, platform)) return
  for (const id of ids) {
    for (let i = registrations.length - 1; i >= 0; i--) {
      const h = registrations[i].current[id]
      if (h && h(e) !== false) {
        e.preventDefault()
        return
      }
    }
  }
}

/** Install the window keydown listener once (App). */
export function installCommandDispatcher(): () => void {
  window.addEventListener('keydown', dispatch)
  return () => window.removeEventListener('keydown', dispatch)
}

// ---------------------------------------------------------------------------
// CodeMirror
// ---------------------------------------------------------------------------

export type EditorCommandHandlers = Partial<Record<CommandId, (view: EditorView, e: KeyboardEvent) => boolean | void>>

/**
 * CodeMirror keymap that runs registry commands: it looks the pressed keys up in the live keymap on every
 * key press, so rebinding in Settings applies to open editors at once. `handlers` is read at key time.
 * `scope` is CodeMirror's keymap scope ("editor search-panel" also runs inside the find panel).
 */
export function commandKeymap(handlers: () => EditorCommandHandlers, precedence: 'high' | 'highest' = 'high', scope?: string): Extension {
  const ext = cmKeymap.of([
    {
      scope,
      any: (view, e) => {
        if (isRecording()) return false
        const ids = commandsForEvent(e)
        if (!ids.length) return false
        const h = handlers()
        for (const id of ids) {
          const fn = h[id]
          if (fn && fn(view, e) !== false) return true
        }
        return false
      }
    }
  ])
  return precedence === 'highest' ? Prec.highest(ext) : Prec.high(ext)
}
