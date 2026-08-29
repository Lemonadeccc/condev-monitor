import type { LabCreateRequest } from '@/types/lab'

export const GENERIC_SCENARIO_PATH = 'apps/backend/lab-runner/examples/generic-page.scenario.json'

type LabBrowserEngine = LabCreateRequest['browser']
type LabAuthenticationMode = LabCreateRequest['authenticationMode']

export function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function buildRunnerCommand(input: {
    runId: string
    serverOrigin: string
    browser: LabBrowserEngine
    authenticationMode: LabAuthenticationMode
    scenarioPath: string
    coverageManifestPath?: string
}): string {
    const scenarioPath = input.scenarioPath.trim() || GENERIC_SCENARIO_PATH
    const coverageManifestPath = input.coverageManifestPath?.trim()

    return [
        `printf 'Paste the one-time Runner Grant: ' >&2`,
        'IFS= read -r -s CONDEV_LAB_RUNNER_TOKEN',
        `printf '\\n' >&2`,
        "pnpm --filter '@condev-monitor/animation-lab-runner...' build && \\",
        'CONDEV_LAB_RUNNER_TOKEN="$CONDEV_LAB_RUNNER_TOKEN" node apps/backend/lab-runner/build/cli.js \\',
        `  --config ${shellQuote(scenarioPath)} \\`,
        ...(coverageManifestPath ? [`  --coverage-manifest ${shellQuote(coverageManifestPath)} \\`] : []),
        `  --browser ${shellQuote(input.browser)} \\`,
        `  --out-dir ${shellQuote('./lab-results')} \\`,
        ...(input.authenticationMode === 'required-local-storage-state'
            ? [`  --storage-state ${shellQuote('/absolute/private/path/storage-state.json')} \\`]
            : []),
        `  --server ${shellQuote(input.serverOrigin)} \\`,
        `  --run-id ${shellQuote(input.runId)}`,
    ].join('\n')
}
