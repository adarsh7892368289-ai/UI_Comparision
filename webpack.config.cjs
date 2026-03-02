// webpack.config.cjs
'use strict';

const path       = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => {
  const isDev = argv.mode === 'development';

  return {
    mode: isDev ? 'development' : 'production',

    entry: {
      background: './src/application/background.js',
      content:    './src/presentation/content.js',
      popup:      './src/presentation/popup.js',
    },

    output: {
      filename: '[name].js',
      path:     path.resolve(__dirname, 'dist'),
      clean:    true,
    },

    devtool: isDev ? 'inline-source-map' : 'source-map',

    plugins: [
      new CopyPlugin({
        patterns: [
          { from: 'manifest.json',               to: '.' },
          { from: 'src/presentation/popup.html', to: '.' },
          { from: 'src/presentation/popup.css',  to: 'popup.css' },
          { from: 'icons',                       to: 'icons' },
          { from: 'libs',                        to: 'libs' },
        ],
      }),
    ],

    performance: {
      hints:             isDev ? false : 'warning',
      maxEntrypointSize: 1_500_000,
      maxAssetSize:      1_500_000,
    },

    resolve: {
      extensions: ['.js'],
    },
  };
};