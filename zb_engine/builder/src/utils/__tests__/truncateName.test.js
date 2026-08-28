/**
 * truncateName.test.js — QR-payload name truncation contract.
 *
 * The QR JSON contract caps `name` at 50 characters total: names longer
 * than 50 are cut to 47 characters + a literal `...`.
 */

import { describe, it, expect } from 'vitest';
import { truncateName, QR_NAME_MAX } from '../truncateName.js';

describe('truncateName', () => {
  it('returns short names unchanged', () => {
    expect(truncateName('Kitchen panel')).toBe('Kitchen panel');
  });

  it('returns an exactly-50-char name unchanged', () => {
    const name = 'x'.repeat(50);
    expect(truncateName(name)).toBe(name);
  });

  it('cuts a 51-char name to 47 chars + "..."', () => {
    const name = 'a'.repeat(51);
    const result = truncateName(name);
    expect(result).toBe(`${'a'.repeat(47)}...`);
    expect(result.length).toBe(QR_NAME_MAX);
  });

  it('cuts a very long name to 47 chars + "..."', () => {
    const name = 'The quick brown fox jumps over the lazy dog again and again';
    const result = truncateName(name);
    expect(result).toBe(`${name.slice(0, 47)}...`);
    expect(result.length).toBe(50);
  });

  it('keeps the empty string empty', () => {
    expect(truncateName('')).toBe('');
  });

  it('coerces non-string input to the empty string', () => {
    expect(truncateName(undefined)).toBe('');
    expect(truncateName(null)).toBe('');
    expect(truncateName(42)).toBe('');
  });

  it('honors a custom max', () => {
    expect(truncateName('abcdefghij', 8)).toBe('abcde...');
    expect(truncateName('abcdefgh', 8)).toBe('abcdefgh');
  });
});
