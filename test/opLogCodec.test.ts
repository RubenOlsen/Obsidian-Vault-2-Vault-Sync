// ABOUTME: Tests for the NDJSON op-log codec (parse, serialize, compact, lastSyncedByPath).
// ABOUTME: Covers round-trip serialization, torn trailing lines, blank lines, malformed entries, and compact logic.

import { describe, test, expect } from 'vitest';
import { parse, serializeLine, lastSyncedByPath, compact } from '../src/OpLogCodec';
import type { LogEntry } from '../src/types';

describe('OpLogCodec', () => {
  const sampleEntry: LogEntry = {
    ts: 1699564800000,
    op: 'create',
    path: 'notes/test.md',
    md5: 'abc123',
  };

  describe('serializeLine', () => {
    test('produces compact JSON with trailing newline', () => {
      const line = serializeLine(sampleEntry);
      expect(line).toBe('{"ts":1699564800000,"op":"create","path":"notes/test.md","md5":"abc123"}\n');
    });

    test('handles all operation types', () => {
      expect(serializeLine({ ...sampleEntry, op: 'update' })).toContain('"op":"update"');
      expect(serializeLine({ ...sampleEntry, op: 'delete' })).toContain('"op":"delete"');
    });
  });

  describe('parse', () => {
    test('parses valid single-line NDJSON', () => {
      const line = serializeLine(sampleEntry);
      const result = parse(line);
      expect(result).toEqual([sampleEntry]);
    });

    test('parses multiple valid lines', () => {
      const entries: LogEntry[] = [
        { ts: 1, op: 'create', path: 'a.md', md5: 'x' },
        { ts: 2, op: 'update', path: 'b.md', md5: 'y' },
        { ts: 3, op: 'delete', path: 'c.md', md5: 'z' },
      ];
      const text = entries.map(serializeLine).join('');
      const result = parse(text);
      expect(result).toEqual(entries);
    });

    test('skips a torn trailing line', () => {
      const good = serializeLine({ ts: 1, op: 'create', path: 'a.md', md5: 'x' });
      expect(parse(good + '{"ts":2,"op":"up')).toHaveLength(1);
    });

    test('skips blank lines', () => {
      const line1 = serializeLine({ ts: 1, op: 'create', path: 'a.md', md5: 'x' });
      const line2 = serializeLine({ ts: 2, op: 'update', path: 'b.md', md5: 'y' });
      const text = line1 + '\n\n' + line2;
      const result = parse(text);
      expect(result).toHaveLength(2);
    });

    test('skips entries missing required fields', () => {
      const valid = '{"ts":1,"op":"create","path":"a.md","md5":"x"}\n';
      const missingOp = '{"ts":2,"path":"b.md","md5":"y"}\n';
      const missingPath = '{"ts":3,"op":"delete","md5":"z"}\n';
      const missingMd5 = '{"ts":4,"op":"create","path":"c.md"}\n';
      const missingTs = '{"op":"update","path":"d.md","md5":"w"}\n';

      const text = valid + missingOp + missingPath + missingMd5 + missingTs;
      const result = parse(text);
      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('a.md');
    });

    test('skips malformed JSON lines', () => {
      const valid1 = '{"ts":1,"op":"create","path":"a.md","md5":"x"}\n';
      const malformed = '{not valid json\n';
      const valid2 = '{"ts":2,"op":"update","path":"b.md","md5":"y"}\n';

      const result = parse(valid1 + malformed + valid2);
      expect(result).toHaveLength(2);
      expect(result[0].ts).toBe(1);
      expect(result[1].ts).toBe(2);
    });

    test('handles empty string', () => {
      expect(parse('')).toEqual([]);
    });

    test('handles only blank lines', () => {
      expect(parse('\n\n\n')).toEqual([]);
    });

    test('skips entries with invalid op values', () => {
      const valid = '{"ts":1,"op":"create","path":"a.md","md5":"x"}\n';
      const invalidOp = '{"ts":2,"op":"destroy","path":"b.md","md5":"y"}\n';
      const valid2 = '{"ts":3,"op":"update","path":"c.md","md5":"z"}\n';

      const result = parse(valid + invalidOp + valid2);
      expect(result).toHaveLength(2);
      expect(result[0].path).toBe('a.md');
      expect(result[1].path).toBe('c.md');
    });
  });

  describe('lastSyncedByPath', () => {
    test('returns latest md5 for each path', () => {
      const entries: LogEntry[] = [
        { ts: 1, op: 'create', path: 'a.md', md5: 'x' },
        { ts: 2, op: 'update', path: 'a.md', md5: 'y' },
        { ts: 3, op: 'create', path: 'b.md', md5: 'z' },
      ];
      const result = lastSyncedByPath(entries);
      expect(result.get('a.md')).toBe('y');
      expect(result.get('b.md')).toBe('z');
    });

    test('returns null when latest op is delete', () => {
      const entries: LogEntry[] = [
        { ts: 1, op: 'create', path: 'a.md', md5: 'x' },
        { ts: 2, op: 'delete', path: 'a.md', md5: 'x' },
      ];
      const result = lastSyncedByPath(entries);
      expect(result.get('a.md')).toBeNull();
    });

    test('handles multiple paths with deletes', () => {
      const entries: LogEntry[] = [
        { ts: 1, op: 'create', path: 'a.md', md5: 'x' },
        { ts: 2, op: 'create', path: 'b.md', md5: 'y' },
        { ts: 3, op: 'delete', path: 'a.md', md5: 'x' },
        { ts: 4, op: 'update', path: 'b.md', md5: 'z' },
      ];
      const result = lastSyncedByPath(entries);
      expect(result.get('a.md')).toBeNull();
      expect(result.get('b.md')).toBe('z');
    });

    test('uses highest ts to determine latest entry per path', () => {
      const entries: LogEntry[] = [
        { ts: 5, op: 'update', path: 'a.md', md5: 'newest' },
        { ts: 1, op: 'create', path: 'a.md', md5: 'oldest' },
        { ts: 3, op: 'update', path: 'a.md', md5: 'middle' },
      ];
      const result = lastSyncedByPath(entries);
      expect(result.get('a.md')).toBe('newest');
    });

    test('handles empty array', () => {
      const result = lastSyncedByPath([]);
      expect(result.size).toBe(0);
    });
  });

  describe('compact', () => {
    test('keeps one line per live file, drops deletes', () => {
      const e: LogEntry[] = [
        { ts: 1, op: 'create', path: 'a.md', md5: 'x' },
        { ts: 2, op: 'update', path: 'a.md', md5: 'y' },
        { ts: 3, op: 'create', path: 'b.md', md5: 'z' },
        { ts: 4, op: 'delete', path: 'b.md', md5: 'z' },
      ];
      expect(compact(e)).toEqual([{ ts: 2, op: 'update', path: 'a.md', md5: 'y' }]);
    });

    test('keeps latest ts and md5 per path', () => {
      const entries: LogEntry[] = [
        { ts: 1, op: 'create', path: 'a.md', md5: 'x' },
        { ts: 2, op: 'update', path: 'a.md', md5: 'y' },
        { ts: 3, op: 'update', path: 'a.md', md5: 'z' },
        { ts: 4, op: 'create', path: 'b.md', md5: 'w' },
      ];
      const result = compact(entries);
      expect(result).toEqual([
        { ts: 3, op: 'update', path: 'a.md', md5: 'z' },
        { ts: 4, op: 'update', path: 'b.md', md5: 'w' },
      ]);
    });

    test('changes all ops to update', () => {
      const entries: LogEntry[] = [
        { ts: 1, op: 'create', path: 'a.md', md5: 'x' },
        { ts: 2, op: 'create', path: 'b.md', md5: 'y' },
      ];
      const result = compact(entries);
      expect(result.every(e => e.op === 'update')).toBe(true);
    });

    test('orders result by ts ascending', () => {
      const entries: LogEntry[] = [
        { ts: 5, op: 'create', path: 'c.md', md5: 'z' },
        { ts: 1, op: 'create', path: 'a.md', md5: 'x' },
        { ts: 3, op: 'create', path: 'b.md', md5: 'y' },
      ];
      const result = compact(entries);
      expect(result.map(e => e.ts)).toEqual([1, 3, 5]);
    });

    test('handles empty array', () => {
      expect(compact([])).toEqual([]);
    });

    test('handles all deletes', () => {
      const entries: LogEntry[] = [
        { ts: 1, op: 'create', path: 'a.md', md5: 'x' },
        { ts: 2, op: 'delete', path: 'a.md', md5: 'x' },
      ];
      expect(compact(entries)).toEqual([]);
    });
  });

  describe('round-trip', () => {
    test('parse(serializeLine(e)) equals [e]', () => {
      const entries: LogEntry[] = [
        { ts: 1699564800000, op: 'create', path: 'notes/test.md', md5: 'abc123' },
        { ts: 1699564900000, op: 'update', path: 'journal/2024-11-10.md', md5: 'def456' },
        { ts: 1699565000000, op: 'delete', path: 'archive/old.md', md5: 'ghi789' },
      ];

      for (const entry of entries) {
        const serialized = serializeLine(entry);
        const parsed = parse(serialized);
        expect(parsed).toEqual([entry]);
      }
    });
  });
});
