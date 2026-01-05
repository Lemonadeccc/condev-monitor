export interface Application {
    id: number
    appId: string
    type: 'vanilla' | 'react' | 'vue'
    name: string
    description?: string | null
    createdAt?: string
    updatedAt?: string
    user?: {
        id: number
    }
}

export interface ApiResponse<T> {
    data: T
    success: boolean
}

export interface ApplicationListData {
    applications: Application[]
    count: number
}

export type ApplicationListResponse = ApiResponse<ApplicationListData>

export type CreateApplicationResponse = ApiResponse<Application>
