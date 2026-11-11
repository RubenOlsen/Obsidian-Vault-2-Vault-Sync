import { describe, it, expect } from 'vitest';
import pkg from '../package.json';

describe('scaffold', () => {
  it('exposes a non-empty version from package.json', () => {
    expect(typeof pkg.version).toBe('string');
    expect(pkg.version.length).toBeGreaterThan(0);
  });
});
