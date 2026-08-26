module.exports = {
    rootDir: '.',
    testRegex: 'test/.*\.spec\.ts$',
    transform: {
        '^.+\.ts$': [
            '<rootDir>/../browser/node_modules/ts-jest',
            {
                tsconfig: '<rootDir>/tsconfig.spec.json',
            },
        ],
    },
    moduleNameMapper: {
        '^(\.{1,2}/.*)\.js$': '$1',
        '^@condev-monitor/monitor-sdk-core$': '<rootDir>/../core/src/index.ts',
    },
    testEnvironment: 'node',
}
