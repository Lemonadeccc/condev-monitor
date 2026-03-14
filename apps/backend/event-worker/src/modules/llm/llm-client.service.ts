import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

export type ChatMessage = {
    role: 'system' | 'user' | 'assistant'
    content: string
}

@Injectable()
export class LlmClientService {
    private readonly provider: 'openai' | 'anthropic' | 'openai-compatible'
    private readonly baseUrl: string
    private readonly apiKey: string
    private readonly model: string
    private readonly maxTokens: number
    private readonly temperature: number

    constructor(private readonly config: ConfigService) {
        this.provider = (this.config.get<string>('LLM_PROVIDER') ?? 'openai-compatible') as 'openai' | 'anthropic' | 'openai-compatible'
        this.baseUrl = (this.config.get<string>('LLM_BASE_URL') ?? 'http://localhost:11434/v1').replace(/\/+$/, '')
        this.apiKey = this.config.get<string>('LLM_API_KEY') ?? ''
        this.model = this.config.get<string>('LLM_MODEL') ?? 'gpt-4o-mini'
        this.maxTokens = Number(this.config.get<string>('LLM_MAX_TOKENS') ?? '1024')
        this.temperature = Number(this.config.get<string>('LLM_TEMPERATURE') ?? '0.1')
    }

    isEnabled(): boolean {
        return this.provider === 'openai-compatible' ? Boolean(this.baseUrl) : Boolean(this.apiKey)
    }

    async chatCompletion(messages: ChatMessage[]): Promise<string> {
        if (this.provider !== 'openai-compatible' && !this.apiKey) {
            throw new Error('LLM_API_KEY is not configured')
        }

        if (this.provider === 'anthropic') {
            return this.callAnthropic(messages)
        }

        return this.callOpenAiCompatible(messages)
    }

    private async callOpenAiCompatible(messages: ChatMessage[]): Promise<string> {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
            },
            body: JSON.stringify({
                model: this.model,
                messages,
                max_tokens: this.maxTokens,
                temperature: this.temperature,
            }),
        })

        if (!res.ok) {
            const text = await res.text()
            throw new Error(`LLM API error ${res.status}: ${text}`)
        }

        const json = (await res.json()) as {
            choices?: Array<{ message?: { content?: string } }>
        }
        return json.choices?.[0]?.message?.content?.trim() ?? ''
    }

    private async callAnthropic(messages: ChatMessage[]): Promise<string> {
        const systemContent = messages
            .filter(m => m.role === 'system')
            .map(m => m.content)
            .join('\n\n')
        const conversation = messages
            .filter(m => m.role !== 'system')
            .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

        const res = await fetch(`${this.baseUrl}/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: this.model,
                max_tokens: this.maxTokens,
                temperature: this.temperature,
                system: systemContent,
                messages: conversation,
            }),
        })

        if (!res.ok) {
            const text = await res.text()
            throw new Error(`Anthropic API error ${res.status}: ${text}`)
        }

        const json = (await res.json()) as {
            content?: Array<{ type?: string; text?: string }>
        }
        return json.content?.find(c => c.type === 'text')?.text?.trim() ?? ''
    }
}
