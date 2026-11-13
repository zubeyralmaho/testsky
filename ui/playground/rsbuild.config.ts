import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { defineConfig } from '@rsbuild/core';
import { pluginLess } from '@rsbuild/plugin-less';
import { pluginNodePolyfill } from '@rsbuild/plugin-node-polyfill';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginSvgr } from '@rsbuild/plugin-svgr';

const require = createRequire(import.meta.url);

// Midscene aliases this to its shared package's source; the published package
// ships the same polyfill built.
const asyncHooksPolyfill = path.join(
  path.dirname(require.resolve('@midscene/shared/polyfills')),
  'async-hooks.js',
);
if (!fs.existsSync(asyncHooksPolyfill)) {
  throw new Error(`async_hooks polyfill not found at ${asyncHooksPolyfill}`);
}

// The build is one HTML file, served as it is by `testsky playground`.
export default defineConfig({
  html: {
    template: './template/index.html',
    templateParameters: {
      faviconDataUri: `data:image/png;base64,${fs
        .readFileSync(path.join(__dirname, 'src/assets/favicon-32x32.png'))
        .toString('base64')}`,
    },
    inject: 'body',
  },
  source: {
    tsconfigPath: 'tsconfig.json',
  },
  resolve: {
    alias: {
      async_hooks: asyncHooksPolyfill,
    },
  },
  tools: {
    rspack: {
      module: {
        rules: [
          // Tesky's fonts, inlined so the page stays one file.
          {
            test: /\.woff2$/,
            include: /[\\/]@fontsource/,
            type: 'asset/inline',
          },
          {
            test: /\.(webp|png)$/,
            include: path.join(__dirname, 'src/assets'),
            type: 'asset/inline',
          },
        ],
        parser: {
          javascript: {
            dynamicImportMode: 'eager',
          },
        },
      },
      externals: ['sharp'],
      ignoreWarnings: [/Critical dependency: the request of a dependency is an expression/],
    },
  },
  output: {
    assetPrefix: './',
    inlineScripts: true,
    injectStyles: true,
  },
  plugins: [
    pluginReact(),
    pluginLess(),
    pluginNodePolyfill(),
    // The visualizer imports its icons as components by default (it is built
    // that way upstream); the report asks for them with "?react". This serves both.
    pluginSvgr({ svgrOptions: { exportType: 'default' } }),
  ],
});
