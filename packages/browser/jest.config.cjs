module.exports = {
    moduleFileExtensions: ['js', 'json', 'ts'],
    rootDir: 'src',
    testRegex: '.*\\.spec\\.ts$',
    transform: {
        '^.+\\.(t|j)s$': [
            'ts-jest',
            {
                tsconfig: 'tsconfig.spec.json',
            },
        ],
    },
    moduleNameMapper: {
        '^@condev-monitor/monitor-sdk-browser$': '<rootDir>/index.ts',
        '^@condev-monitor/monitor-sdk-animation$': '<rootDir>/../../animation/src/index.ts',
        '^@condev-monitor/monitor-sdk-animation/devtools$': '<rootDir>/../../animation/src/devtools.ts',
        '^@condev-monitor/monitor-sdk-core$': '<rootDir>/../../core/src/index.ts',
        '^@condev-monitor/monitor-sdk-browser-utils$': '<rootDir>/../../browser-utils/src/index.ts',
        '^@condev-monitor/monitor-sdk-browser-utils/performance-runtime$': '<rootDir>/../../browser-utils/src/performance-runtime.ts',
    },
    testEnvironment: 'node',
}
