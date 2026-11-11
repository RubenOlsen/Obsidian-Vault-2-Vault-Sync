// ABOUTME: esbuild bundler config for the Obsidian plugin.
// ABOUTME: Bundles src/main.ts into main.js, externalizing the Obsidian/Electron runtime.
import esbuild from 'esbuild';

const production = process.argv.includes('production');

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'cjs',
  target: 'es2022',
  platform: 'node',
  external: ['obsidian', 'node:*', 'fs', 'path', 'crypto'],
  sourcemap: production ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  logLevel: 'info',
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
