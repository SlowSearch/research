import babel from 'rollup-plugin-babel';
import babelrc from 'babelrc-rollup';
import commonjs from 'rollup-plugin-commonjs';
import resolve from 'rollup-plugin-node-resolve';
import eslint from 'rollup-plugin-eslint';

let pkg = require('./package.json');
let external = Object.keys(pkg.dependencies || {});

let plugins = [
  eslint(),
  babel(babelrc()),
  resolve({
    jsnext: true,
    main: true
  }),
  commonjs()
];

export default [{
  entry: 'src/slowsearch-v1.js',
  plugins: plugins,
  targets: [{
    dest: 'dist/slowsearch-v1.js',
    format: 'umd',
    moduleName: 'slowsearch_v1',
    sourceMap: true
  }]
}, {
  entry: 'src/slowsearch-v2.js',
  plugins: plugins,
  targets: [{
    dest: 'dist/slowsearch-v2.js',
    format: 'umd',
    moduleName: 'slowsearch_v2',
    sourceMap: true
  }]
}, {
  entry: 'src/slowsearch-v3.js',
  plugins: plugins,
  targets: [{
    dest: 'dist/slowsearch-v3.js',
    format: 'umd',
    moduleName: 'slowsearch_v3',
    sourceMap: true
  }]
}];