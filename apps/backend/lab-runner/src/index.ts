export { LAB_RUNNER_CONTRACT_VERSION, RemoteLabClient, remoteFailureCode } from './remote'
export type { RemoteLabConnectionOptions } from './remote'
export { runScenarioActions, scenarioActionId } from './actions'
export type { RunScenarioActionsOptions } from './actions'
export { aggregateMeasuredAttempts, projectDiagnosticAttemptMetrics } from './aggregate'
export { createBrowserDriver, validateBrowserDriverScenario } from './browser-driver'
export type {
    BrowserDriver,
    BrowserDriverCapabilities,
    BrowserDriverContextOptions,
    BrowserDriverLaunchOptions,
    BrowserDriverSession,
    LabAutomationContext,
    LabAutomationPage,
    LabBoundingBox,
    LabBrowserEngine,
} from './browser-driver'
export { createDiscoveredAnimationProposal, discoverAnimationCandidates } from './explorer'
export type { DiscoverAnimationCandidatesOptions, DiscoveredAnimationProposal } from './explorer'
export { decodePageProbeResult } from './probe-result'
export type { DecodedPageProbeResult, ExpectedPageProbeAction } from './probe-result'
export {
    buildLabLocalBudgetDisplayEvent,
    createTerminalLabLocalDisplaySink,
    projectLabLocalDisplayEvent,
    safePublish,
} from './local-display'
export type {
    LabLocalDisplayActionEvent,
    LabLocalDisplayAttempt,
    LabLocalDisplayBudgetEvent,
    LabLocalDisplayBudgetSummary,
    LabLocalDisplayEvent,
    LabLocalDisplaySink,
    TerminalLabLocalDisplayOptions,
} from './local-display'
export { lighthouseSkipReason, runAnimationLab } from './runner'
export type { LabRunOptions, LabRunResult, LighthouseSkipReason } from './runner'
export { createScenarioProtocolHash } from './scenario-protocol'
export {
    actionWindowFromProbe,
    buildAnimationLabSemantics,
    decorateLabMetric,
    decorateLighthouseLabMetric,
    measurementContractForReport,
    probeFrameContract,
    projectAttemptsForReport,
    reportScenarioActions,
} from './semantics'
