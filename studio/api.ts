export interface PageSettings {
  backdrop: string
  display: string
  fill: number
  cursor: { style: string; size: number; label?: string | undefined; tip?: [number, number] }
  music: false | { track: string; volume: number }
}

export interface StudioMessage {
  from: 'you' | 'agent'
  text: string
  at?: number
  sent: string
  read?: boolean
  delivered?: boolean
  by?: string
}

export interface Agent {
  session?: string | undefined
  agent?: string | undefined
}

export type AgentStatus = Agent & { listening: boolean }

export type Stem = 'click' | 'typing' | 'voice'

export type ExportFormat = 'mp4' | 'webm' | 'gif'

export interface StudioState {
  title: string
  video: string
  take: string
  boot: string
  look: PageSettings
  backdrops: readonly string[]
  owned: { backdrop: string | null; cursor: string | null; music: string | null }
  tracks: readonly string[]
  hold: number
  stems: Stem[]
  stemGain: number
  limit: number
  canvas: { width: number; height: number }
}

export type StudioEvent =
  | { type: 'hello'; boot: string; chat: StudioMessage[]; agent: AgentStatus | null }
  | { type: 'chat'; chat: StudioMessage[] }
  | { type: 'agent'; agent: AgentStatus | null }
  | { type: 'config' }

export interface Highlighted {
  at: number
  until: number
  box: number[]
  zoom: number
  style: 'box' | 'magnify' | 'cursor'
  colour: string
}

export interface StageData {
  length: number
  frames: { file: string; at: number }[]
  pointer: { at: number; x: number; y: number }[]
  clicks: { at: number; x: number; y: number }[]
  highlights: Highlighted[]
  addresses: { at: number; label: string }[]
  title: string
}

export interface Stage {
  data: StageData
  seek(t: number): Promise<void>
}
