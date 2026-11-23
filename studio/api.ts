import type { Span } from './time.ts'

export interface PageSettings {
  backdrop: string
  display: string
  fill: number
  cursor: { style: string; size: number; label?: string | undefined; tip?: [number, number] }
  music: false | { track: string; volume: number }
  sound: { click: boolean; typing: boolean }
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

// In the take's own time, which the studio's timeline is drawn in.
export interface ShownEdit extends Span {
  steps: number[]
}

// What the timeline draws, in the take's own time: the cuts and speed-ups are laid over it.
export interface TimelineData {
  length: number
  addresses: { at: number; label: string }[]
  // step: the film step the click is in, when the take recorded steps' times.
  clicks: { at: number; step?: number; muted: boolean }[]
  highlights: Highlighted[]
  edits: ShownEdit[]
}

export type EditRequest =
  | { from: number; to: number; cut: true }
  | { from: number; to: number; speed: number }
  | { steps: number[]; remove: true }
  | { steps: number[]; cut: true }
  | { steps: number[]; speed: number }
  | { steps: number[]; from: number; to: number }
  | { steps: number[]; by: number }

export interface SoundRequest {
  step: number
  click: boolean
}

export type HighlightRequest =
  { step: number; style: Highlighted['style'] } | { step: number; remove: true }

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
  timeline: TimelineData
}

export type StudioEvent =
  | { type: 'hello'; boot: string; chat: StudioMessage[]; agent: AgentStatus | null }
  | { type: 'chat'; chat: StudioMessage[] }
  | { type: 'agent'; agent: AgentStatus | null }
  | { type: 'config' }
  | { type: 'stage'; timeline: TimelineData }

export interface Highlighted {
  step: number
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
