import { build } from 'esbuild';
import { mkdirSync, rmSync, createWriteStream, createReadStream, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';

// Minimal zip writer (store-only) so we don't pull in another dep just to package.
// AWS Lambda accepts both stored and deflated entries.
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, 'dist');
const buildDir = join(distDir, 'build');

const handlers = ['analyze', 'profile', 'upload', 'lemon-billing', 'lemon-webhook'];

rmSync(distDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

console.log('→ bundling handlers with esbuild');
await Promise.all(
  handlers.map((name) =>
    build({
      entryPoints: [join(__dirname, 'src', 'handlers', `${name}.ts`)],
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'esm',
      outfile: join(buildDir, name, 'index.mjs'),
      banner: {
        // esbuild ESM output needs these shims for require/import.meta on Node 20 Lambda
        js: "import { createRequire as _gl_cr } from 'module'; const require = _gl_cr(import.meta.url);",
      },
      external: [],
      minify: true,
      sourcemap: false,
      logLevel: 'info',
    }),
  ),
);

console.log('→ packaging zips');
for (const name of handlers) {
  const handlerDir = join(buildDir, name);
  const zipPath = join(distDir, `${name}.zip`);

  // Use the system zip on *nix; on Windows fall back to PowerShell Compress-Archive.
  let result;
  if (process.platform === 'win32') {
    result = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path '${join(handlerDir, '*')}' -DestinationPath '${zipPath}' -Force`,
      ],
      { stdio: 'inherit' },
    );
  } else {
    result = spawnSync('zip', ['-jq', zipPath, join(handlerDir, 'index.mjs')], {
      stdio: 'inherit',
    });
  }
  if (result.status !== 0) {
    throw new Error(`Failed to zip handler ${name}`);
  }
  console.log(`  ✓ ${name}.zip`);
}

console.log('Done.');
