import { describe, it, expect } from 'vitest';
import { codepointOffsetToUtf16 } from '../editor-integration';

describe('codepointOffsetToUtf16', () => {
  it('maps ASCII 1:1', () => {
    expect(codepointOffsetToUtf16('hello', 0)).toBe(0);
    expect(codepointOffsetToUtf16('hello', 3)).toBe(3);
    expect(codepointOffsetToUtf16('hello', 5)).toBe(5);
  });

  it('counts a Non-BMP emoji as one codepoint / two UTF-16 units', () => {
    // "😀" = U+1F600 = one codepoint, UTF-16 length 2
    const text = '😀x';
    expect(text.length).toBe(3); // 2 + 1
    expect(codepointOffsetToUtf16(text, 0)).toBe(0);
    expect(codepointOffsetToUtf16(text, 1)).toBe(2); // past the emoji
    expect(codepointOffsetToUtf16(text, 2)).toBe(3); // past 'x'
  });

  it('retain-over-emoji + insert lands at correct UTF-16 offset', () => {
    // Loro retain(1) over "😀abc" → insert after emoji at UTF-16 2
    const text = '😀abc';
    const insertAt = codepointOffsetToUtf16(text, 1);
    expect(insertAt).toBe(2);
    expect(text.slice(0, insertAt) + '!' + text.slice(insertAt)).toBe('😀!abc');
  });

  it('delete behind an emoji uses UTF-16 range, not codepoint range', () => {
    // Doc "😀xy"; Loro delete of "x" is retain(1)+delete(1)
    // Wrong (codepoint-as-UTF16): from=1,to=2 → corrupts the surrogate pair
    // Right: from=2,to=3 → removes only "x"
    const text = '😀xy';
    const from = codepointOffsetToUtf16(text, 1);
    const to = codepointOffsetToUtf16(text, 2);
    expect(from).toBe(2);
    expect(to).toBe(3);
    expect(text.slice(0, from) + text.slice(to)).toBe('😀y');
  });
});
