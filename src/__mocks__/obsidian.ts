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
  setName(_: string) { return this; }
  setDesc(_: string) { return this; }
  addText(_: (_: unknown) => unknown) { return this; }
  addSlider(_: (_: unknown) => unknown) { return this; }
  addToggle(_: (_: unknown) => unknown) { return this; }
  addButton(_: (_: unknown) => unknown) { return this; }
}
export class App {
  workspace = {
    on: (_event: string, _cb: unknown) => {},
    iterateAllLeaves: (_cb: unknown) => {},
  };
  vault = {};
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
}
