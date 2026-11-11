import { describe, it, expect } from 'vitest';
import { md5 } from '../src/Checksum';

describe('md5', () => {
  it('computes the known digest for "abc"', () => {
    expect(md5(Buffer.from('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  it('accepts a string as well as a Buffer', () => {
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
  });
});
