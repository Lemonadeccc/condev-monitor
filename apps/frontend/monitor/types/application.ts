export interface Application {
    id: number
    appId: string
    type: 'vanilla' | 'react' | 'vue'
    name: string
    description: string
    createdAt?: string
    updatedAt?: string
}

export interface ApplicationListResponse {
    application: Application[]
}
