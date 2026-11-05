import { defineConfig } from 'vite';

import babel from '@rollup/plugin-babel';

export default defineConfig({
	publicDir: false,
	ssr: {
		noExternal: true,
	},
	build: {
		ssr: 'src/cli.ts',
		minify: false,
		target: 'esnext',
		rollupOptions: {
			output: {
				banner: '#!/usr/bin/env node',
			},
		},
	},
	esbuild: {
		target: 'es2022',
	},
	plugins: [
		{
			enforce: 'pre',
			...babel({
				babelrc: false,
				babelHelpers: 'bundled',
				extensions: ['.tsx'],
				plugins: [['@babel/plugin-syntax-typescript', { isTSX: true }], ['@intrnl/jsx-to-string/babel']],
			}),
		},
	],
});
