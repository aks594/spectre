module.exports = {
  /**
   * This is the main entry point for your application, it's the first file
   * that runs in the main process.
   */
  entry: './src/main/main.js',
  target: 'electron-main',
  // Put your normal webpack config below here
  externals: ['koffi'],
  module: {
    rules: require('./webpack.rules'),
  },
};
