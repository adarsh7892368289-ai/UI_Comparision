const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  mode: 'production',
  
  entry: {
    popup: './src/presentation/popup.js',
    content: './src/presentation/content.js',
    background: './src/application/background.js'
  },

  output: {
    filename: '[name].js', 
    path: path.resolve(__dirname, 'dist'),
    clean: true, 
  },

  plugins: [
    new CopyPlugin({
      patterns: [
        { from: "manifest.json", to: "." },
        { from: "src/presentation/popup.html", to: "." },
        { from: "icons", to: "icons" },
        { from: "src/presentation/popup.css", to: "popup.css" },
        { from: "libs", to: "libs" }
      ],
    }),
  ],

  performance: {
    hints: false,
    maxEntrypointSize: 512000,
    maxAssetSize: 512000
  },
};