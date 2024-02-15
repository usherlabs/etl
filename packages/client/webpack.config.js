/* eslint-disable prefer-template */

process.env.NODE_ENV = process.env.NODE_ENV || 'development'; // set a default NODE_ENV

const path = require('path');

const webpack = require('webpack');
const TerserPlugin = require('terser-webpack-plugin');
const LodashWebpackPlugin = require('lodash-webpack-plugin');
const { merge } = require('webpack-merge');
const { BundleAnalyzerPlugin } = require('webpack-bundle-analyzer');
const { GitRevisionPlugin } = require('git-revision-webpack-plugin');
const NodePolyfillPlugin = require('node-polyfill-webpack-plugin');
const Dotenv = require('dotenv-webpack');
const { rimrafSync } = require('rimraf');

const pkg = require('./package.json');

const gitRevisionPlugin = new GitRevisionPlugin();

module.exports = (_, argv) => {
	const isProduction =
		argv.mode === 'production' || process.env.NODE_ENV === 'production';
	const analyze = !!process.env.BUNDLE_ANALYSIS;

	const commonConfig = {
		// cache: {
		// 	type: 'filesystem',
		// },
		name: 'logstore-client',
		mode: isProduction ? 'production' : 'development',
		entry: {
			'logstore-client': path.join(__dirname, 'src', 'exports-browser.ts'),
		},
		devtool: 'source-map',
		output: {
			umdNamedDefine: true,
		},
		optimization: {
			usedExports: true,
			minimize: false,
			moduleIds: 'named',
		},
		module: {
			parser: {
				javascript: {
					// for wasm
					// see https://stackoverflow.com/a/72484751
					importMeta: false,
				},
			},
			rules: [
				{
					// wasm
					test: /\.wasm$/,
					type: 'javascript/auto',
					use: {
						// if we've used asset/source, it would lose information about the wasm file
						loader: require.resolve('binary-loader'),
						options: {
							name: '[name].[ext]',
						},
					},
				},
				{
					oneOf: [
						{
							// worker helper should be loading the source code instead, as we'll
							// send it to the worker
							test: /workerHelpers\.worker\.js$/,
							type: 'asset/source',
						},
						{
							test: /(\.jsx|\.js|\.ts)$/,
							exclude: /(node_modules|bower_components)/,
							use: {
								loader: 'babel-loader',
								options: {
									configFile: path.resolve(
										__dirname,
										'.babel.browser.config.js',
									),
									babelrc: false,
									cacheDirectory: true,
								},
							},
						},
					],
				},
			],
		},
		resolve: {
			modules: [
				'node_modules',
				...require.resolve.paths(''),
				path.resolve('./vendor'),
			],
			extensions: ['.json', '.js', '.ts'],
		},
		plugins: [
			gitRevisionPlugin,
			new webpack.EnvironmentPlugin({
				NODE_ENV: process.env.NODE_ENV,
				version: pkg.version,
				GIT_VERSION: gitRevisionPlugin.version(),
				GIT_COMMITHASH: gitRevisionPlugin.commithash(),
				GIT_BRANCH: gitRevisionPlugin.branch(),
			}),
			new Dotenv(),
		],
		performance: {
			hints: 'warning',
		},
	};

	const clientConfig = merge({}, commonConfig, {
		target: 'web',
		output: {
			filename: '[name].web.js',
			libraryTarget: 'umd',
			library: 'LogStoreClient',
			globalObject: 'globalThis',
		},
		resolve: {
			alias: {
				stream: 'readable-stream',
				util: 'util',
				'@ethersproject/wordlists': require.resolve(
					'@ethersproject/wordlists/lib/browser-wordlists.js'
				),
				crypto: require.resolve('crypto-browserify'),
				buffer: require.resolve('buffer/'),
			},
			fallback: {
				module: false,
				fs: false,
				net: false,
				http: false,
				https: false,
				express: false,
				ws: false,
			},
		},
		plugins: [
			new NodePolyfillPlugin({
				excludeAliases: ['console'],
			}),
			new LodashWebpackPlugin(),
			...(analyze
				? [
						new BundleAnalyzerPlugin({
							analyzerMode: 'static',
							openAnalyzer: false,
							generateStatsFile: true,
						}),
				  ]
				: []),
		],
	});

	let clientMinifiedConfig;
	if (isProduction) {
		clientMinifiedConfig = merge({}, clientConfig, {
			cache: false,
			optimization: {
				minimize: true,
				minimizer: [
					new TerserPlugin({
						parallel: true,
						terserOptions: {
							ecma: 2018,
							output: {
								comments: false,
							},
						},
					}),
				],
			},
			output: {
				filename: '[name].web.min.js',
			},
		});
	}

	return [clientConfig, clientMinifiedConfig].filter(Boolean);
};
