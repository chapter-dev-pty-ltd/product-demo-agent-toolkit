import type { PageSettings, StudioState } from './api.ts'

type Music = PageSettings['music']

export interface Mixer {
  start(from: number, length: number): Promise<void>
  stop(): void
  now(): number
  update(): void
  setHeard(on: boolean): void
  reloadSounds(): void
}

export const musicSrc = (m: Exclude<Music, false>): string =>
  m.track === 'own' ? '/studio/own/music' : '/studio/music/' + m.track

export function createMixer(state: StudioState, music: () => Music): Mixer {
  const mixer = new AudioContext()
  const master = mixer.createGain()
  master.connect(mixer.destination)
  const limiter = mixer.createDynamicsCompressor()
  limiter.threshold.value = 20 * Math.log10(state.limit)
  limiter.knee.value = 0
  limiter.ratio.value = 20
  limiter.attack.value = 0.001
  limiter.release.value = 0.05
  limiter.connect(master)
  const restore = mixer.createGain()
  restore.gain.value = 1 / state.stemGain
  restore.connect(limiter)
  const musicLevel = mixer.createGain()
  musicLevel.connect(limiter)

  const decode = (url: string): Promise<AudioBuffer | null> =>
    fetch(url)
      .then((r) => r.arrayBuffer())
      .then((b) => mixer.decodeAudioData(b))
      .catch(() => null)
  const sounds = () => Promise.all(state.stems.map((stem) => decode('/studio/sound/' + stem)))
  let stemBuffers = sounds()
  const musicBuffers: Record<string, Promise<AudioBuffer | null>> = {}
  const musicKey = () => {
    const m = music()
    return m ? musicSrc(m) : null
  }

  // The playhead is read from the audio clock while playing, so picture and sound can't drift.
  let sources: AudioBufferSourceNode[] = []
  let generation = 0
  let origin = 0
  let startedAt = 0
  let length = 0
  let playingMusic: string | null = null
  const now = () => origin + mixer.currentTime - startedAt
  const stop = () => {
    generation++
    for (const s of sources) s.stop()
    sources = []
  }
  const begin = (buffer: AudioBuffer, to: AudioNode, when: number, offset: number) => {
    const s = mixer.createBufferSource()
    s.buffer = buffer
    s.connect(to)
    s.start(when, offset)
    sources.push(s)
    return s
  }
  const level = () => {
    const g = musicLevel.gain
    const m = music()
    const volume = m ? m.volume : 0
    const fade = Math.min(state.hold, length)
    const at = (time: number) => startedAt + time - origin
    g.cancelScheduledValues(0)
    g.setValueAtTime(volume * Math.max(0, Math.min(1, (length - now()) / fade)), mixer.currentTime)
    if (now() < length - fade) g.setValueAtTime(volume, at(length - fade))
    g.linearRampToValueAtTime(0, at(length))
  }
  const start = async (from: number, total: number) => {
    stop()
    const go = generation
    origin = from
    length = total
    startedAt = mixer.currentTime
    await mixer.resume()
    const key = musicKey()
    const track = key ? (musicBuffers[key] ??= decode(key)) : null
    const [stems, tune] = await Promise.all([stemBuffers, track])
    if (go !== generation) return
    const when = mixer.currentTime
    const at = now()
    for (const b of stems) if (b && at < b.duration) begin(b, restore, when, at)
    if (tune) begin(tune, musicLevel, when, at % tune.duration).loop = true
    playingMusic = key
    level()
  }

  return {
    start,
    stop,
    now,
    update: () => (playingMusic !== musicKey() ? void start(now(), length) : level()),
    setHeard: (on) => void (master.gain.value = on ? 1 : 0),
    reloadSounds: () => void (stemBuffers = sounds()),
  }
}
