export class AnimationRumV3IngestValidationError extends Error {
    constructor(readonly codes: readonly string[]) {
        super('Invalid Animation RUM v3 soft navigation ingestion value')
        this.name = 'AnimationRumV3IngestValidationError'
    }
}
