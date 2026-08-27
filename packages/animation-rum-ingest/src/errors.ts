export class AnimationRumV2IngestValidationError extends Error {
    constructor(readonly codes: readonly string[]) {
        super('Invalid Animation RUM v2 ingestion value')
        this.name = 'AnimationRumV2IngestValidationError'
    }
}
