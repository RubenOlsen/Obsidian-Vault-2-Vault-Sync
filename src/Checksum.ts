// ABOUTME: MD5 checksum helper for change and conflict detection.
// ABOUTME: Not for security; MD5 is chosen for speed and zero dependencies.
import { createHash } from 'node:crypto';

export function md5(data: Buffer | string): string {
  return createHash('md5').update(data).digest('hex');
}
