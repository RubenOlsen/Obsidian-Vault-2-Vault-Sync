// ABOUTME: Pure NDJSON codec for operational log entries (parse, serialize, compact, lastSyncedByPath).
// ABOUTME: No fs, no Obsidian: string/array in, string/array out. Torn trailing lines are silently skipped.

import type { LogEntry } from './types';

/**
 * Parse NDJSON text into an array of LogEntry objects.
 * Skips blank lines, malformed JSON, and entries missing required fields.
 * A trailing unparseable/partial line is silently skipped.
 */
export function parse(text: string): LogEntry[] {
  const lines = text.split('\n');
  const entries: LogEntry[] = [];

  for (const line of lines) {
    // Skip blank lines
    if (line.trim() === '') continue;

    try {
      const obj = JSON.parse(line);

      // Validate required fields exist
      if (
        typeof obj.ts === 'number' &&
        (obj.op === 'create' || obj.op === 'update' || obj.op === 'delete') &&
        typeof obj.path === 'string' &&
        typeof obj.md5 === 'string'
      ) {
        entries.push(obj as LogEntry);
      }
      // Silently skip entries missing required fields
    } catch {
      // Silently skip malformed JSON (includes torn trailing lines)
    }
  }

  return entries;
}

/**
 * Serialize a single LogEntry to compact JSON with a trailing newline.
 */
export function serializeLine(entry: LogEntry): string {
  return JSON.stringify(entry) + '\n';
}

/**
 * Build a map of path → latest md5 (or null if latest op is delete).
 * Returns the md5 of the latest operation per path (determined by highest ts),
 * or null when that path's latest operation is a delete.
 */
export function lastSyncedByPath(entries: LogEntry[]): Map<string, string | null> {
  // Build a map of path → latest entry (by highest ts)
  const latestEntry = new Map<string, LogEntry>();

  for (const entry of entries) {
    const current = latestEntry.get(entry.path);
    if (!current || entry.ts > current.ts) {
      latestEntry.set(entry.path, entry);
    }
  }

  // Map to md5 or null if latest op is delete
  const result = new Map<string, string | null>();
  for (const [path, entry] of latestEntry.entries()) {
    result.set(path, entry.op === 'delete' ? null : entry.md5);
  }

  return result;
}

/**
 * Compact the log: one 'update' entry per path whose latest op is NOT delete,
 * carrying that path's latest md5 and latest ts. Delete operations and superseded
 * history are dropped. Result is ordered by ts ascending.
 */
export function compact(entries: LogEntry[]): LogEntry[] {
  // Build a map of path → latest entry
  const latest = new Map<string, LogEntry>();

  for (const entry of entries) {
    const current = latest.get(entry.path);
    if (!current || entry.ts > current.ts) {
      latest.set(entry.path, entry);
    }
  }

  // Filter out paths whose latest op is delete, convert all to 'update', and sort by ts
  const result: LogEntry[] = [];

  for (const entry of latest.values()) {
    if (entry.op !== 'delete') {
      result.push({
        ts: entry.ts,
        op: 'update',
        path: entry.path,
        md5: entry.md5,
      });
    }
  }

  // Sort by timestamp ascending
  result.sort((a, b) => a.ts - b.ts);

  return result;
}
