// Minimal stub of the Obsidian SDK for unit tests.
// Real implementations are provided via vi.mock() in individual test files.
export const requestUrl = async (_opts: unknown): Promise<unknown> => ({ json: {} });
export class TFile {
  path = '';
  basename = '';
  extension = '';
}
export class PluginSettingTab {}
export class Setting {
  settingEl: StubElement;
  nameEl: StubElement;
  descEl: StubElement;
  constructor(containerEl?: StubElement) {
    this.settingEl = makeStubElement('div');
    this.nameEl = this.settingEl.createDiv();
    this.descEl = this.settingEl.createDiv();
    containerEl?.children?.push(this.settingEl);
  }
  setName(name: string) { this.nameEl.textContent = name; return this; }
  setDesc(desc: string) { this.descEl.textContent = desc; return this; }
  addText(cb?: (_: unknown) => unknown) {
    if (cb) {
      const fake = {
        setPlaceholder() { return this; },
        setValue() { return this; },
        onChange() { return this; },
        inputEl: { type: '' },
      };
      cb(fake);
    }
    return this;
  }
  addSlider(_: (_: unknown) => unknown) { return this; }
  addToggle(_: (_: unknown) => unknown) { return this; }
  addButton(cb?: (_: unknown) => unknown) {
    if (cb) {
      const fake = {
        setButtonText() { return this; },
        setCta() { return this; },
        setWarning() { return this; },
        setDisabled() { return this; },
        onClick(_fn: () => void) { return this; },
      };
      cb(fake);
    }
    return this;
  }
}
export const Platform = { isDesktopApp: false, isMobileApp: false };
export class App {
  workspace = {
    on: (_event: string, _cb: unknown) => {},
    iterateAllLeaves: (_cb: unknown) => {},
  };
  vault = {};
}

// Minimal DOM-less element stub that supports the Obsidian DOM extensions
// the plugin actually uses: createEl, createDiv, createSpan, empty, addClass,
// appendText, setAttribute, textContent, style. The vitest environment is
// 'node' (no jsdom), so we avoid pulling in a full DOM — tests only read
// back a few fields, they don't rely on real layout or events.
interface StubElement {
  tag: string;
  children: StubElement[];
  textContent: string;
  className: string;
  style: Record<string, string>;
  attrs: Record<string, string>;
  inputEl: { type: string };
  createEl: (tag: string, opts?: { text?: string; cls?: string }) => StubElement;
  createDiv: (opts?: { text?: string; cls?: string }) => StubElement;
  createSpan: (opts?: { text?: string; cls?: string }) => StubElement;
  empty: () => void;
  addClass: (cls: string) => void;
  removeClass: (cls: string) => void;
  toggleClass: (cls: string, on: boolean) => void;
  appendText: (text: string) => void;
  setAttribute: (key: string, value: string) => void;
  addEventListener: (event: string, callback: (event: unknown) => void) => void;
  listeners: Record<string, (event: unknown) => void>;
}

function makeStubElement(tag = 'div'): StubElement {
  const el: StubElement = {
    tag,
    children: [],
    textContent: '',
    className: '',
    style: {},
    attrs: {},
    listeners: {},
    addEventListener(event, callback) { el.listeners[event] = callback; },
    inputEl: { type: '' },
    createEl(t, opts) {
      return spawn(t, opts);
    },
    createDiv(opts) {
      return spawn('div', opts);
    },
    createSpan(opts) {
      return spawn('span', opts);
    },
    empty() {
      el.children.length = 0;
      el.textContent = '';
    },
    addClass(cls) {
      if (el.className.split(' ').includes(cls)) return;
      el.className = el.className ? `${el.className} ${cls}` : cls;
    },
    removeClass(cls) {
      el.className = el.className.split(' ').filter(c => c && c !== cls).join(' ');
    },
    toggleClass(cls, on) {
      if (on) el.addClass(cls);
      else el.removeClass(cls);
    },
    appendText(text) {
      el.textContent += text;
    },
    setAttribute(key, value) {
      el.attrs[key] = value;
    },
  };
  function spawn(t: string, opts?: { text?: string; cls?: string }): StubElement {
    const child = makeStubElement(t);
    if (opts?.text) child.textContent = opts.text;
    if (opts?.cls) child.className = opts.cls;
    el.children.push(child);
    return child;
  }
  return el;
}

// Modal — calls onOpen()/onClose() from open()/close() so tests can drive
// the lifecycle without a real DOM host. contentEl is a stub element tree.
export class Modal {
  app: App;
  contentEl: StubElement;
  constructor(app: App) {
    this.app = app;
    this.contentEl = makeStubElement();
  }
  open(): void {
    const self = this as unknown as { onOpen?: () => void };
    self.onOpen?.();
  }
  close(): void {
    const self = this as unknown as { onClose?: () => void };
    self.onClose?.();
  }
}

// Notice — no-op stub. Tests don't assert on Notice content, only on
// the absence/presence of crashes during error paths.
export class Notice {
  constructor(_msg: string, _timeout?: number) {}
  setMessage(_msg: string): this { return this; }
  hide(): void {}
}

export class Plugin {
  app!: App;
  async loadData(): Promise<unknown> { return {}; }
  async saveData(_: unknown): Promise<void> {}
  addCommand(_: unknown): void {}
  registerEvent(_: unknown): void {}
  addSettingTab(_: unknown): void {}
  registerEditorExtension(_: unknown): void {}
  addStatusBarItem(): { setText: (_: string) => void } { return { setText: () => {} }; }
  addRibbonIcon(_icon: string, _title: string, _cb: () => void): unknown { return makeStubElement(); }
  registerObsidianProtocolHandler(_: string, __: unknown): void {}
  registerDomEvent(_: unknown, __: string, ___: unknown): void {}
}
