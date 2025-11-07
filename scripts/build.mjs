import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { build } from 'esbuild';

const outDir = join(process.cwd(), 'dist');

async function bundle() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, 'smoke'), { recursive: true });

  await build({
    entryPoints: [join('smoke', 'bootstrap.ts')],
    bundle: true,
    outfile: join(outDir, 'smoke', 'bootstrap.js'),
    target: 'esnext',
    format: 'esm',
    platform: 'neutral',
    external: ['k6', 'k6/*']
  });

  // eslint-disable-next-line no-console
  console.log('k6 bundles compiled to dist/');
}

bundle().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
