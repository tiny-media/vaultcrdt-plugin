import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import initWasmModule, { blob_path_key } from '../../wasm/vaultcrdt_wasm';
import { isAttachmentPath, attachmentCap } from '../path-policy';

const vectors = JSON.parse(
  readFileSync(new URL('../../docs/blob-path-key-vectors.json', import.meta.url), 'utf8'),
) as {
  key_version: number;
  unicode_version: string;
  vectors: { input: string; key: string | null }[];
};

describe('blob_path_key (WASM)', () => {
  beforeAll(async () => {
    const bytes = readFileSync(new URL('../../wasm/vaultcrdt_wasm_bg.wasm', import.meta.url));
    await initWasmModule({ module_or_path: bytes });
  });

  it('freezes key_version 1', () => {
    expect(vectors.key_version).toBe(1);
  });

  it.each(vectors.vectors)('$input', ({ input, key }) => {
    expect(blob_path_key(input)).toBe(key ?? undefined);
  });

  it('has intentional collisions and separations', () => {
    expect(blob_path_key('Bilder/Übersicht.PNG')).toBe(blob_path_key('Bilder/U\u0308bersicht.png'));
    expect(blob_path_key('Notes/Straße.pdf')).toBe(blob_path_key('Notes/STRASSE.pdf'));
    expect(blob_path_key('İstanbul.jpg')).not.toBe(blob_path_key('Istanbul.jpg'));
    expect(blob_path_key('Ａｂｃ.png')).not.toBe(blob_path_key('abc.png'));
  });
});

describe('isAttachmentPath', () => {
  const accepted = [
    'a.jpg', 'a.jpeg', 'a.png', 'a.webp', 'a.gif', 'a.heic', 'a.heif', 'a.avif',
    'a.pdf', 'a.mp3', 'a.m4a', 'a.ogg', 'a.oga', 'a.opus', 'a.flac', 'a.wav', 'a.webm', 'a.3gp',
    'Bilder/Übersicht.PNG', 'nested/dir/x.JPG', 'x.svg',
  ];
  it.each(accepted)('accepts %s', (p) => expect(isAttachmentPath(p)).toBe(true));

  const rejected = [
    'x.mp4', 'x.txt', 'x.md', 'noext',
    '.obsidian/x.png', '.Obsidian/x.png', '.trash/x.png',
    'a//b.png', '/x.png', '../x.png', './x.png', 'a/b/../c.png', 'a./x.png',
    'foo.png ', '',
  ];
  it.each(rejected)('rejects %s', (p) => expect(isAttachmentPath(p)).toBe(false));

  it('foo.json and x.css stay non-attachments; category json needs the toggle', () => {
    expect(isAttachmentPath('foo.json')).toBe(false);
    expect(isAttachmentPath('x.css')).toBe(false);
    expect(isAttachmentPath('.obsidian/app.json')).toBe(false);
    expect(isAttachmentPath('.obsidian/app.json', { settings: true, styles: false })).toBe(true);
    expect(attachmentCap('.obsidian/app.json')).toBe(2 * 1024 * 1024);
  });

  it('foo/bar.svg is an image attachment under IMAGE_CAP', () => {
    expect(isAttachmentPath('foo/bar.svg')).toBe(true);
    expect(attachmentCap('foo/bar.svg')).toBe(10 * 1024 * 1024);
    expect(blob_path_key('x.svg')).toBe('x.svg');
  });
});
