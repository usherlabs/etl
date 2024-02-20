/** @type {import("ts-jest").JestConfigWithTsJest} */
module.exports = {
	preset: 'ts-jest/presets/js-with-ts',
	testEnvironment: 'node',
	clearMocks: true,
	// can't use prettier 3 with jest
	prettierPath: require.resolve('prettier-2'),
	transform: {
		'^.+\\.ts$': [
			'ts-jest',
			{
				tsconfig: 'tsconfig.jest.json',
			},
		],
	},
	setupFilesAfterEnv: [
		'jest-extended/all',
		'dotenv/config',
		'<rootDir>/src/polyfills.ts',
		'<rootDir>/src/polyfillsNodeOnly.ts',
	],
};
