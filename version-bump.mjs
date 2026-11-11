// ABOUTME: Version-bump script run by `npm version` to sync manifest.json and versions.json.
// ABOUTME: Sets manifest.version to the new npm version and records version -> minAppVersion in versions.json.
import { readFileSync, writeFileSync } from 'fs';

const targetVersion = process.env.npm_package_version;

// Bump manifest.json to the target version; keep its minAppVersion.
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync('manifest.json', JSON.stringify(manifest, null, 2) + '\n');

// Record this version's minimum Obsidian version in versions.json.
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
versions[targetVersion] = minAppVersion;
writeFileSync('versions.json', JSON.stringify(versions, null, 2) + '\n');
