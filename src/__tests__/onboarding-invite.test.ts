import { describe, it, expect, vi, beforeEach } from 'vitest';
const ui = vi.hoisted(() => ({ texts: [] as any[], buttons: [] as any[], toggles: [] as any[], rows: [] as any[], qr: vi.fn() }));
vi.mock('obsidian', async () => {
  const base = await vi.importActual<any>('../__mocks__/obsidian');
  return { ...base, Setting: class {
    name = ''; descEl = { codes: [] as any[], createEl(tag: string, o: any) { const e = { tag, ...o }; this.codes.push(e); return e; } };
    constructor() { ui.rows.push(this); }
    setName(n: string) { this.name = n; return this; } setDesc() { return this; }
    addText(cb: any) {
      const t = { inputEl: { readOnly: false }, value: '', setValue(v: string) { this.value = v; return this; },
        setPlaceholder() { return this; }, onChange(fn: any) { this.change = fn; return this; }, change: null };
      ui.texts.push(t); cb(t); return this;
    }
    addButton(cb: any) {
      const b = { label: '', click: null, setButtonText(v: string) { this.label = v; return this; },
        setCta() { return this; }, setWarning() { return this; }, onClick(fn: any) { this.click = fn; return this; } };
      ui.buttons.push(b); cb(b); return this;
    }
    addToggle(cb: any) {
      const t = { value: true, change: null, setValue(v: boolean) { this.value = v; return this; },
        onChange(fn: any) { this.change = fn; return this; } };
      ui.toggles.push(t); cb(t); return this;
    }
  } };
});
vi.mock('qrcode-generator', () => ({ default: () => ({ addData: ui.qr, make() {}, createDataURL() { return 'data:image/gif;base64,test'; } }) }));
vi.mock('../wasm-bridge', () => ({ initWasm: vi.fn() }));
import { App } from 'obsidian';
import { SetupModal } from '../setup-modal';
import { InviteModal } from '../invite-modal';
import { ReplaceConnectionModal } from '../replace-connection-modal';
import { DEFAULT_SETTINGS } from '../settings';
import VaultCRDTPlugin from '../main';
import { assertNoSecret } from '../diagnostics';
const settings = { ...DEFAULT_SETTINGS, serverUrl: 'https://sync.example.com', vaultId: 'friends', vaultSecret: 'secret-second-channel' };
beforeEach(() => { ui.texts.length = 0; ui.buttons.length = 0; ui.toggles.length = 0; ui.rows.length = 0; ui.qr.mockClear(); vi.restoreAllMocks(); });
describe('onboarding UI', () => {
  it('locks the prefilled values and allows an editable device name', () => {
    const modal = new SetupModal(new App(), settings, { serverUrl: settings.serverUrl, vaultId: settings.vaultId, newerVersion: false });
    modal.open();
    expect(ui.texts.slice(0, 2).map(t => [t.value, t.inputEl.readOnly])).toEqual([[settings.serverUrl, true], ['friends', true]]);
    expect(ui.texts[2].inputEl.readOnly).toBe(false);
    ui.texts[2].change('phone');
    expect((modal as any).deviceName).toBe('phone');
    modal.close();
  });
  it('renders two public QRs by default, copies secrets only on demand, and clears secret QR when toggled off', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    try {
      const modal = new InviteModal(new App(), settings); modal.open();
      expect(ui.qr).toHaveBeenCalledTimes(2);
      expect(ui.qr.mock.calls[0][0]).toBe('obsidian://brat?plugin=tiny-media/vaultcrdt-plugin');
      for (const [data] of ui.qr.mock.calls) assertNoSecret(data, settings.vaultSecret);
      expect(ui.qr.mock.calls[1][0]).not.toContain('invite=');
      expect(ui.toggles[0].value).toBe(false);
      expect(writeText).not.toHaveBeenCalled();
      await ui.buttons.find(b => b.label === 'Copy vault secret').click();
      expect(writeText).toHaveBeenCalledWith(settings.vaultSecret);
      ui.toggles[0].change(true);
      expect(ui.qr).toHaveBeenLastCalledWith(settings.vaultSecret, 'Byte');
      // Each copyable is one compact labelled row whose description is a
      // wrap-friendly <code> (long URIs overflowed the tablet modal).
      const copyRows = ui.rows.filter(r => r.descEl.codes.length > 0);
      expect(copyRows.map(r => [r.name, r.descEl.codes[0].tag, r.descEl.codes[0].cls])).toEqual([
        ['Plugin install link', 'code', 'vcrdt-copy-code'],
        ['Setup link', 'code', 'vcrdt-copy-code'],
        ['Vault secret', 'code', 'vcrdt-copy-code'],
      ]);
      expect(copyRows[1].descEl.codes[0].text).toContain('vaultcrdt');
      ui.toggles[0].change(false);
      const secretContainer = Array.from(modal.contentEl.children).filter((e: any) => e.tag === 'div').at(-1)!;
      expect(secretContainer.children.length).toBe(0);
      modal.close();
    } finally { vi.unstubAllGlobals(); }
  });
  it('wipes only after the join modal succeeds; cancel leaves no trace', async () => {
    const plugin = new VaultCRDTPlugin(new App(), {} as any);
    const order: string[] = [];
    Object.assign(plugin, { app: new App(), settings: { ...settings, onboardingComplete: true }, syncEngineInitialized: true,
      syncEngine: { stop: vi.fn(async () => { order.push('stop'); }), wipeLocalState: vi.fn(async () => { order.push('wipe'); }), start: vi.fn() } });
    vi.spyOn(plugin, 'saveSettings').mockResolvedValue();
    const confirm = vi.spyOn(ReplaceConnectionModal.prototype, 'prompt').mockResolvedValue(false);
    let joinResult: any = null;
    const setup = vi.spyOn(SetupModal.prototype, 'prompt').mockImplementation(async function (this: SetupModal) {
      order.push('modal'); expect((this as any).prefill.vaultId).toBe('new-vault'); return joinResult;
    });
    const params = { v: '1', server: settings.serverUrl, vaultId: 'new-vault' };
    // Replace-declined and join-cancelled: neither may touch stop/wipe
    // (device-test finding 2026-09-06: wipe-before-confirm left the vault
    // unconfigured after cancel).
    await plugin.handleSetupLink(params);
    expect(order).toEqual([]); expect(setup).not.toHaveBeenCalled();
    confirm.mockResolvedValue(true);
    await plugin.handleSetupLink(params);
    expect(order).toEqual(['modal']);
    expect(plugin.settings.onboardingComplete).toBe(true);
    expect(plugin.syncEngine.wipeLocalState).not.toHaveBeenCalled();
    // Join confirmed: now the wipe runs, onboarding resets, sync starts.
    joinResult = { serverUrl: settings.serverUrl, vaultId: 'new-vault', vaultSecret: 's' };
    order.length = 0;
    await plugin.handleSetupLink(params);
    expect(order).toEqual(['modal', 'stop', 'wipe']);
    expect(plugin.settings.onboardingComplete).toBe(false);
    expect(plugin.syncEngine.start).toHaveBeenCalled();
  });
});
