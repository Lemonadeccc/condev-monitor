type PricingRule = {
    provider?: string
    model: string
    currency: string
    inputPerMillion: number
    outputPerMillion: number
}

type PricingConfig = {
    rules?: PricingRule[]
}

export type CostEstimate = {
    currency: string
    inputCost: number
    outputCost: number
    totalCost: number
}

const DEFAULT_RULES: PricingRule[] = [
    {
        provider: 'openai',
        model: 'gpt-5-mini',
        currency: 'USD',
        inputPerMillion: 0.25,
        outputPerMillion: 2.0,
    },
    {
        provider: 'google',
        model: 'gemini-2.5-flash',
        currency: 'USD',
        inputPerMillion: 0.3,
        outputPerMillion: 2.5,
    },
    {
        provider: 'google',
        model: 'gemini-2.5-pro',
        currency: 'USD',
        inputPerMillion: 1.25,
        outputPerMillion: 10.0,
    },
    {
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        currency: 'USD',
        inputPerMillion: 3.0,
        outputPerMillion: 15.0,
    },
    {
        provider: 'anthropic',
        model: 'claude-3-7-sonnet',
        currency: 'USD',
        inputPerMillion: 3.0,
        outputPerMillion: 15.0,
    },
    {
        provider: 'anthropic',
        model: 'claude-3-5-haiku',
        currency: 'USD',
        inputPerMillion: 0.8,
        outputPerMillion: 4.0,
    },
    {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        currency: 'USD',
        inputPerMillion: 1.0,
        outputPerMillion: 5.0,
    },
    {
        provider: 'minimax',
        model: 'minimax-m2.5',
        currency: 'USD',
        inputPerMillion: 0.3,
        outputPerMillion: 1.2,
    },
    {
        provider: 'minimax',
        model: 'minimax-m2.5-highspeed',
        currency: 'USD',
        inputPerMillion: 0.6,
        outputPerMillion: 2.4,
    },
    {
        provider: 'minimax',
        model: 'minimax-m2.1',
        currency: 'USD',
        inputPerMillion: 0.3,
        outputPerMillion: 1.2,
    },
    {
        provider: 'minimax',
        model: 'minimax-m2.1-highspeed',
        currency: 'USD',
        inputPerMillion: 0.6,
        outputPerMillion: 2.4,
    },
    {
        provider: 'minimax',
        model: 'minimax-m2',
        currency: 'USD',
        inputPerMillion: 0.3,
        outputPerMillion: 1.2,
    },
    {
        provider: 'volcengine',
        model: 'doubao-seed-code',
        currency: 'CNY',
        inputPerMillion: 1.2,
        outputPerMillion: 8.0,
    },
    {
        provider: 'zhipu',
        model: 'glm-4-plus',
        currency: 'CNY',
        inputPerMillion: 5.0,
        outputPerMillion: 5.0,
    },
    {
        provider: 'zhipu',
        model: 'charglm-4',
        currency: 'CNY',
        inputPerMillion: 1.0,
        outputPerMillion: 1.0,
    },
    {
        provider: 'zhipu',
        model: 'glm-4v-plus-0111',
        currency: 'CNY',
        inputPerMillion: 4.0,
        outputPerMillion: 4.0,
    },
    {
        provider: 'deepseek',
        model: 'deepseek-chat',
        currency: 'USD',
        inputPerMillion: 0.27,
        outputPerMillion: 1.1,
    },
    {
        provider: 'deepseek',
        model: 'deepseek-reasoner',
        currency: 'USD',
        inputPerMillion: 0.55,
        outputPerMillion: 2.19,
    },
    {
        provider: 'dashscope',
        model: 'qwen2.5-7b-instruct',
        currency: 'CNY',
        inputPerMillion: 0.5,
        outputPerMillion: 1.0,
    },
    {
        provider: 'dashscope',
        model: 'qwen2.5-72b-instruct',
        currency: 'CNY',
        inputPerMillion: 4.0,
        outputPerMillion: 12.0,
    },
    {
        provider: 'dashscope',
        model: 'deepseek-r1',
        currency: 'CNY',
        inputPerMillion: 4.0,
        outputPerMillion: 16.0,
    },
]

const PROVIDER_FAMILIES: Record<string, string[]> = {
    openai: ['openai'],
    google: ['google', 'google-ai', 'google.generative-ai', 'google-generative-ai', 'gemini', 'vertex-ai', 'vertex'],
    anthropic: ['anthropic', 'claude', 'bedrock-anthropic', 'vertex-anthropic'],
    minimax: ['minimax', 'minimaxi', 'minimax-openai'],
    volcengine: ['volcengine', 'ark', 'doubao', 'byte', 'bytedance', 'byteplus'],
    zhipu: ['zhipu', 'bigmodel', 'glm'],
    deepseek: ['deepseek'],
    dashscope: ['dashscope', 'qwen', 'alibaba'],
    'openai-compatible': ['openai-compatible', 'openai_compatible', 'compatible', 'custom-openai'],
}

function normalize(value?: string | null) {
    return value?.trim().toLowerCase() ?? ''
}

function roundCurrency(value: number) {
    return Math.round(value * 1_000_000) / 1_000_000
}

function parsePricingRules(raw?: string | null) {
    if (!raw?.trim()) return []

    try {
        const parsed = JSON.parse(raw) as PricingConfig | PricingRule[]
        if (Array.isArray(parsed)) return parsed
        if (Array.isArray(parsed.rules)) return parsed.rules
        return []
    } catch {
        return []
    }
}

function matchesProviderAlias(provider: string, alias: string) {
    return provider === alias || provider.startsWith(`${alias}.`) || provider.startsWith(`${alias}:`) || provider.startsWith(`${alias}/`)
}

function normalizeProviderFamily(provider: string) {
    for (const [family, aliases] of Object.entries(PROVIDER_FAMILIES)) {
        if (aliases.some(alias => matchesProviderAlias(provider, alias))) {
            return family
        }
    }
    return provider
}

function matchesProvider(ruleProvider: string, provider: string) {
    if (!ruleProvider) return true
    if (!provider) return true

    return normalizeProviderFamily(ruleProvider) === normalizeProviderFamily(provider)
}

function matchesRule(rule: PricingRule, model: string, provider: string) {
    const normalizedModel = normalize(rule.model)
    const normalizedProvider = normalize(rule.provider)
    if (!normalizedModel) return false
    if (!matchesProvider(normalizedProvider, provider)) return false
    return model === normalizedModel || model.startsWith(`${normalizedModel}-`)
}

export function estimateTraceCost(params: {
    model?: string | null
    provider?: string | null
    inputTokens?: number | null
    outputTokens?: number | null
    pricingConfig?: string | null
}): CostEstimate | null {
    const model = normalize(params.model)
    const provider = normalize(params.provider)
    const inputTokens = Math.max(0, Number(params.inputTokens ?? 0))
    const outputTokens = Math.max(0, Number(params.outputTokens ?? 0))

    if (!model || (!inputTokens && !outputTokens)) return null

    const rules = [...parsePricingRules(params.pricingConfig), ...DEFAULT_RULES]
    const rule = rules.find(item => matchesRule(item, model, provider))

    if (!rule) return null

    const inputCost = (inputTokens / 1_000_000) * rule.inputPerMillion
    const outputCost = (outputTokens / 1_000_000) * rule.outputPerMillion

    return {
        currency: rule.currency,
        inputCost: roundCurrency(inputCost),
        outputCost: roundCurrency(outputCost),
        totalCost: roundCurrency(inputCost + outputCost),
    }
}
