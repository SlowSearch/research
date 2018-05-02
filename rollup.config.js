import babel from 'rollup-plugin-babel';
import commonjs from 'rollup-plugin-commonjs';
import resolve from 'rollup-plugin-node-resolve';
import eslint from 'rollup-plugin-eslint';

//const pkg = require('./package.json');
//const external = Object.keys(pkg.dependencies || {});

const plugins = [
  eslint(),
  /*babel({
    babelrc: false,
    presets: [
      'es2015-rollup'
    ],
    plugins: [
      'transform-regenerator',
      'transform-runtime'
      // ["transform-runtime", {
      //   "helpers": false,
      //   "polyfill": false,
      //   "regenerator": true,
      //   "moduleName": "rollup-regenerator-runtime"
      // }]
    ],
    exclude: 'node_modules/**',
    externalHelpers: true
    runtimeHelpers: true
  }),*/
  resolve({
    jsnext: true,
    main: true,
    browser: true
  }),
  commonjs()
  // commonjs({ namedExports: { '/idb.js': [ 'open' ] }})
];

const plugins_just_bundle = [
  eslint(),
  resolve({
    jsnext: true,
    main: true,
    browser: true
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
}, {
  entry: 'src/slowsearch-v4.js',
  plugins: plugins,
  targets: [{
    dest: 'dist/slowsearch-v4.js',
    format: 'umd',
    moduleName: 'slowsearch_v4',
    sourceMap: true
  }]
}, {
  entry: 'src/slowsearch-v5.js',
  plugins: plugins_just_bundle,
  targets: [{
    dest: 'dist/slowsearch-v5.js',
    format: 'umd',
    moduleName: 'slowsearch_v5',
    sourceMap: true
  }]
}, {
  entry: 'src/slowsearch-v6.js',
  plugins: plugins_just_bundle,
  targets: [{
    dest: 'dist/slowsearch-v6.js',
    format: 'umd',
    moduleName: 'slowsearch_v6',
    sourceMap: true
  }]
}];