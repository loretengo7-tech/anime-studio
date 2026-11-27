/**
 * ScriptUI model (After Effects .jsx panels/dialogs) — rendered by
 * <ScriptUIView/> in the Extensions panel. Supports the common controls,
 * resource strings ("group{orientation:'row', ok: Button{text:'OK'}}"),
 * dockable panels (thisObj instanceof Panel) and floating palettes.
 */
import type { HostCallbacks } from './aeDom'
import { hostSession } from './aeDom'

type Handler = ((this: SUIControl, ...a: unknown[]) => unknown) | null

const listeners = new Set<() => void>()
let version = 0
export function subscribeSUI(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb) } }
export function suiVersion() { return version }
let pending = false
function bump() {
  version++
  if (pending) return
  pending = true
  queueMicrotask(() => { pending = false; listeners.forEach(f => f()) })
}

let logSink: (m: string) => void = () => { }

export class SUIControl {
  type: string
  parent: SUIControl | null
  children: SUIControl[] = []
  text = ''
  value: unknown = undefined
  enabled = true
  visible = true
  helpTip = ''
  orientation = ''
  alignChildren: unknown = undefined
  alignment: unknown = undefined
  spacing: number | undefined = undefined
  margins: unknown = undefined
  preferredSize: { width: number; height: number } & number[]
  size: unknown = undefined
  minvalue = 0
  maxvalue = 100
  items: SUIControl[] = []
  index = 0
  selected = false
  properties: Record<string, unknown> = {}
  onClick: Handler = null
  onChange: Handler = null
  onChanging: Handler = null
  onDoubleClick: Handler = null
  onShow: Handler = null
  onClose: Handler = null
  onResize: Handler = null
  name = ''
  checked = false
  graphics: Record<string, unknown>
  layout: { layout: (_f?: boolean) => void; resize: () => void }
  _selection: SUIControl | null = null;
  [k: string]: unknown

  constructor(type: string, parent: SUIControl | null, text?: string, props?: Record<string, unknown>) {
    this.type = type.toLowerCase()
    this.parent = parent
    if (text !== undefined) this.text = String(text)
    this.properties = props ?? {}
    const ps: number[] & { width: number; height: number } = Object.assign([-1, -1], { width: -1, height: -1 })
    Object.defineProperty(ps, 'width', { get: () => ps[0], set: v => { ps[0] = v; bump() } })
    Object.defineProperty(ps, 'height', { get: () => ps[1], set: v => { ps[1] = v; bump() } })
    this.preferredSize = ps as never
    if (this.type === 'slider' || this.type === 'scrollbar' || this.type === 'progressbar') this.value = 0
    if (this.type === 'checkbox' || this.type === 'radiobutton') this.value = false
    const self = this
    this.graphics = {
      font: { name: 'Inter', size: 12, style: 'REGULAR' },
      newPen: () => ({}), newBrush: () => ({}), newFont: () => ({}),
      PenType: { SOLID_COLOR: 0 }, BrushType: { SOLID_COLOR: 0 },
      set foregroundColor(_v: unknown) { }, set backgroundColor(_v: unknown) { },
    }
    this.layout = { layout: () => bump(), resize: () => bump() }
    return new Proxy(this, {
      set(t, k, v) {
        (t as Record<string | symbol, unknown>)[k] = v
        if (k === 'value' && (t.type === 'radiobutton') && v) for (const s of t.parent?.children ?? []) if (s !== self && s.type === 'radiobutton') (s as SUIControl).value = false
        bump()
        return true
      },
    })
  }

  // ---- tree
  add(type: string, bounds?: unknown, text?: unknown, props?: Record<string, unknown>): SUIControl {
    if (typeof type === 'string' && /[{]/.test(type)) return this.addResource(type)
    const t = String(type).toLowerCase()
    if (t === 'item' && (this.type === 'dropdownlist' || this.type === 'listbox')) {
      const it = new SUIControl('item', this, String(text ?? bounds ?? ''))
      it.index = this.items.length
      this.items.push(it)
      bump()
      return it
    }
    if (t === 'separator' && (this.type === 'dropdownlist')) { const it = new SUIControl('separator', this, '-'); it.index = this.items.length; this.items.push(it); return it }
    const c = new SUIControl(t, this, typeof bounds === 'string' && text === undefined ? bounds : (text as string | undefined), props)
    if ((t === 'dropdownlist' || t === 'listbox') && Array.isArray(props?.items)) for (const x of props!.items as unknown[]) c.add('item', String(x))
    this.children.push(c)
    bump()
    return c
  }
  remove(c: SUIControl | number) {
    if (typeof c === 'number') { this.items.splice(c, 1); this.children.splice(c, 1) }
    else { this.items = this.items.filter(x => x !== c); this.children = this.children.filter(x => x !== c) }
    bump()
  }
  removeAll() { this.items = []; this._selection = null; bump() }
  find(text: string) { return this.items.find(i => i.text === text) ?? null }
  get selection(): SUIControl | null {
    if (this.type === 'tabbedpanel') return this._selection ?? this.children[0] ?? null
    return this._selection
  }
  set selection(v: SUIControl | number | null) {
    const it = typeof v === 'number' ? (this.type === 'tabbedpanel' ? this.children[v] : this.items[v]) ?? null : v
    for (const i of this.items) i.selected = i === it
    this._selection = it
    bump()
  }
  addResource(res: string): SUIControl {
    const tree = parseResource(res)
    return buildFromResource(this, tree)
  }

  // ---- window-ish
  show() { if (this.onShow) callHandler(this, this.onShow); this.visible = true; openHook(this); return 1 }
  hide() { this.visible = false; closeHook(this) }
  close(_r?: number) { if (this.onClose) callHandler(this, this.onClose); this.visible = false; closeHook(this); return 1 }
  center() { }
  notify(ev?: string) {
    const h = ev === 'onChange' ? this.onChange : ev === 'onChanging' ? this.onChanging : this.onClick ?? this.onChange
    if (h) callHandler(this, h)
  }
  dispatchEvent() { return true }
  addEventListener(ev: string, fn: Handler) {
    if (ev === 'click') this.onClick = fn
    else if (ev === 'change') this.onChange = fn
    else if (ev === 'changing') this.onChanging = fn
  }
  removeEventListener() { }
  toString() { return this.text }
}

/** `this` inside handlers is the control; doc edits commit as one undo step. */
export function callHandler(ctl: SUIControl, h: Handler, ...a: unknown[]) {
  try { hostSession.run(() => h!.call(ctl, ...a)) } catch (e) { logSink(`Script error: ${e instanceof Error ? e.message : String(e)}`); throw e }
  finally { bump() }
}

let openHook: (w: SUIControl) => void = () => { }
let closeHook: (w: SUIControl) => void = () => { }

export class ScriptUIWindow extends SUIControl { }

const RES_TYPES = 'dialog|palette|window|group|panel|button|statictext|edittext|checkbox|radiobutton|slider|dropdownlist|listbox|iconbutton|image|progressbar|tabbedpanel|tab|scrollbar|treeview|flashplayer'
function parseResource(src: string): Record<string, unknown> {
  const js = src.replace(new RegExp(`\\b(${RES_TYPES})\\s*\\{`, 'gi'), (_m, t: string) => `{__type:'${t.toLowerCase()}',`)
  // eslint-disable-next-line no-new-func
  return new Function(`return (${js})`)() as Record<string, unknown>
}
function buildFromResource(parent: SUIControl, tree: Record<string, unknown>): SUIControl {
  const t = String(tree.__type ?? 'group')
  const isWin = t === 'dialog' || t === 'palette' || t === 'window'
  const node = isWin ? parent : parent.add(t, undefined, typeof tree.text === 'string' ? tree.text : undefined, (tree.properties as Record<string, unknown>) ?? undefined)
  for (const [k, v] of Object.entries(tree)) {
    if (k === '__type' || k === 'properties') continue
    if (v && typeof v === 'object' && !Array.isArray(v) && (v as Record<string, unknown>).__type) {
      const child = buildFromResource(node, v as Record<string, unknown>)
      child.name = k
      ;(node as Record<string, unknown>)[k] = child
    } else if (k === 'items' && Array.isArray(v)) {
      for (const x of v) node.add('item', String(x))
    } else if (k === 'preferredSize' && Array.isArray(v)) {
      node.preferredSize.width = Number(v[0]); node.preferredSize.height = Number(v[1])
    } else (node as Record<string, unknown>)[k] = v
  }
  return node
}

export function makeScriptUI(cb: HostCallbacks) {
  logSink = cb.log
  openHook = w => { if (w instanceof ScriptUIWindow && w !== cb.panel) cb.openWindow?.(w) }
  closeHook = () => { }
  class Window extends ScriptUIWindow {
    constructor(type?: string, title?: string, _bounds?: unknown, props?: Record<string, unknown>) {
      const isRes = typeof type === 'string' && /[{]/.test(type)
      super(isRes ? 'palette' : String(type ?? 'palette'), null, isRes ? '' : title, props)
      if (isRes) this.addResource(type!)
      if (!this.orientation) this.orientation = 'column'
    }
    static alert(m: string) { cb.alert(String(m)) }
    static confirm(m: string) { return window.confirm(String(m)) }
    static prompt(m: string, d?: string) { return window.prompt(String(m), d ?? '') }
    static find() { return null }
  }
  class Panel extends ScriptUIWindow { }
  const ScriptUI = {
    environment: { keyboardState: { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, keyName: '' } },
    frameworkName: 'AnimeStudio',
    version: '6.2',
    compatability: {},
    newFont: () => ({}),
    newImage: () => ({}),
    applicationFonts: {},
    FontStyle: { REGULAR: 0, BOLD: 1, ITALIC: 2, BOLDITALIC: 3 },
    Alignment: { LEFT: 0, RIGHT: 1, CENTER: 2, FILL: 3 },
    events: { createEvent: () => ({ initEvent() { } }) },
  }
  return { Window, Panel, ScriptUI, Group: SUIControl, Button: SUIControl }
}

export function makeDockPanel(title: string): ScriptUIWindow {
  const p = new ScriptUIWindow('panel', null, title)
  p.orientation = 'column'
  return p
}
