#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { copyFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  cut,
  explore,
  init,
  copySkills,
  installSkills,
  installedSkills,
  setup,
  loadKeys,
  readFootage,
  readSecret,
  saveKey,
  review,
  videoLength,
  NeedsDecision,
  CONFIG_FILE,
  readConfig,
  readFilm,
  rehearse,
  send,
  serve,
  exploreIn,
  findVideo,
  filesOf,
  latestTake,
  listVideos,
  lookToRaw,
  newRun,
  newVideo,
  pruneRuns,
  recentChat,
  type Video,
  shoot,
  speakLines,
  studio,
  openStudio,
  sayInStudio,
  stopStudio,
  waitForStudio,
  wordAt,
  type Spoken,
  version,
  type Footage,
} from './index.ts'

const USAGE = `product-demo-agent-toolkit ${version}

0. Get ready, and see what's missing (run it first):
  product-demo-agent-toolkit init
  product-demo-agent-toolkit key elevenlabs         Save a voice provider's key (asks for it, hidden, or reads it piped in)

1. Start a video. It gets a short id: every command after this one starts with it.
  product-demo-agent-toolkit new "<title>" [--session name]   Its title, or else the session's name
  product-demo-agent-toolkit videos                 Every video: id, title, takes

2. Explore the app, off camera, to learn it and find the path. Every action is logged, pinned.
   Name an element by its ref from look (@e12), or by a point on look's screenshot (640,320):
  product-demo-agent-toolkit explore <video> <url>  Open the app in a background browser and show the screen
  product-demo-agent-toolkit look <video> [--all]   What's on screen as an accessibility tree with refs, and a screenshot
  product-demo-agent-toolkit handles <video>        The small grab handles on screen (resize, rotate, sliders) and where they are
  product-demo-agent-toolkit click <video> <el> [--double] [--right] [--with Shift+Meta] [--at 0.9,0.5]
  product-demo-agent-toolkit fill <video> <el> "text"     Click into a field and type, replacing what's there
  product-demo-agent-toolkit select <video> <el> "option" Choose an option in a native <select>
  product-demo-agent-toolkit type <video> "text"    Type where the caret is, like "@Sam" to open a mention menu
  product-demo-agent-toolkit press <video> <key>    Press a key, like Enter or Meta+K
  product-demo-agent-toolkit hover <video> <el> [--for 2] Rest the pointer on an element, to show it or open what it reveals
  product-demo-agent-toolkit drag <video> <el> <el> [--at x,y] [--to-at x,y]
  product-demo-agent-toolkit scroll <video> up|down [--in <el>] [--by 600]
  product-demo-agent-toolkit upload <video> <file> [<el>] Upload a file through the control that opens the picker
  product-demo-agent-toolkit visit <video> <path>
  product-demo-agent-toolkit wait <video> "text" [--gone] | <seconds>
  product-demo-agent-toolkit back <video>           Mark the last step undone and return to the screen before it
  product-demo-agent-toolkit end <video>            Close the browser

3. Write the video's film.json from its explore log (both are in its folder), then rehearse it until it's right:
  product-demo-agent-toolkit voice <video>          Speak the film's lines, and show when each step's word lands
  product-demo-agent-toolkit rehearse <video>       A full run without the camera, with a still after each step

4. Shoot it, cut it, and work on it with the user in the studio:
  product-demo-agent-toolkit shoot <video>          A new take
  product-demo-agent-toolkit cut <video> [--out video.mp4]  Cut the latest take into the video's video.mp4
  product-demo-agent-toolkit review <video | video.mp4>     An image of frames from across the video, to check it by
  product-demo-agent-toolkit studio <video> [--session name] [--agent name] [--say "reply"]
                                                    Open the video in the studio, then wait for the user's next message there and print it
  product-demo-agent-toolkit studio <video> --stop  Close its studio

A <video> is its id, or words from its title.

Set up, once: product-demo-agent-toolkit setup   Install the command for good, and the skills for every agent on this machine
             product-demo-agent-toolkit skills [dir]   Just the skills: for every agent found (Claude Code, Codex, Cursor, Gemini CLI, Copilot, OpenCode), or into dir

Everything is kept in ~/.product-demo. Its config.json is the default look for new videos (each video copies it into its own
look.json, which the studio changes): backdrop (sky, any of the 22 in library/backdrops, a hex, or a path to your own .jpg/.png/.webp),
display (none | browser), window ({ width, height, fill }, default 1600x900 filling 0.92 of the video),
cursor (black | pink | lime | macos | a hex | a path to your own .svg, or { style, size, label, tip }), sound (true | false | { click }, default true),
music (false | lofi | a path to an audio file, or { track, volume }, default false).
It also holds what every video shares: mode (just_do_it | ask), voice, keep (rehearsals and takes kept per video, default 5),
review (cut also makes the review image, default false).`

loadKeys()

const EXPLORE = new Set([
  'look',
  'handles',
  'click',
  'fill',
  'select',
  'type',
  'press',
  'hover',
  'drag',
  'scroll',
  'upload',
  'visit',
  'wait',
  'back',
  'end',
])

const raw = process.argv.slice(2)
const exploring = EXPLORE.has(raw[0] ?? '')
const parsed = (() => {
  try {
    return parseArgs({
      args: exploring ? [] : raw,
      allowPositionals: true,
      options: {
        out: { type: 'string', short: 'o' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
        session: { type: 'string' },
        agent: { type: 'string' },
        say: { type: 'string' },
        stop: { type: 'boolean' },
        serve: { type: 'boolean' },
      },
    })
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : error}\n\n${USAGE}`)
    process.exit(1)
  }
})()
const { values, positionals } = parsed
const help = values.help || (exploring && raw.some((arg) => arg === '--help' || arg === '-h'))
const [command, ...args] = exploring ? raw : positionals
const [input] = args

const warn = (warnings: string[]) => {
  for (const warning of warnings) console.log(`Check: ${warning}`)
}

const videoNamed = async (ref: string | undefined): Promise<Video> => {
  if (!ref)
    throw new Error('Which video? Give its id, or words from its title. `videos` lists them.')
  return findVideo(ref)
}
const configOf = (video: Video) => readConfig(filesOf(video).look)

const oldProjectFolder = () => {
  if (!existsSync(join('.product-demo', 'config.json'))) return
  console.log(
    `Check: this project has .product-demo/config.json from an earlier version, which isn't read any more. Settings now live in ${CONFIG_FILE}, the default look for new videos: move what you want there, giving your own files by their full path. Old shoots in .product-demo can't be cut by this version.`,
  )
}

try {
  if (help) {
    console.log(USAGE)
  } else if (values.version) {
    console.log(version)
  } else if (command === '__serve' && input && args[1]) {
    exploreIn(input)
    await serve(args[1])
  } else if (command === 'new') {
    oldProjectFolder()
    const video = await newVideo(input, values.session)
    console.log(
      `Made "${video.title}": its id is ${video.id}. Every command for it starts with that id.`,
    )
    console.log(`Its folder: ${video.dir}`)
    console.log(`Next: product-demo-agent-toolkit explore ${video.id} <url>`)
  } else if (command === 'videos') {
    const videos = await listVideos()
    if (!videos.length)
      console.log('No videos yet. Start one: product-demo-agent-toolkit new "<title>"')
    for (const video of videos) {
      const take = await latestTake(video).then(
        ({ n }) => `take ${n}`,
        () => 'not shot',
      )
      console.log(`${video.id}  ${video.title}  (${take})`)
    }
  } else if (command === 'explore' && input && args[1]) {
    const video = await videoNamed(input)
    exploreIn(filesOf(video).explore)
    console.log(await explore(args[1]))
  } else if (command && EXPLORE.has(command)) {
    const video = await videoNamed(args[0])
    exploreIn(filesOf(video).explore)
    console.log(await send(command, args.slice(1)))
  } else if (command === 'rehearse') {
    const video = await videoNamed(input)
    const config = await configOf(video)
    const dir = await newRun(video, 'rehearsals')
    const rehearsal = await rehearse(await readFilm(filesOf(video).film), dir, config).catch(
      async (error) => {
        await rm(dir, { recursive: true, force: true })
        throw error
      },
    )
    await pruneRuns(video, 'rehearsals', config.keep)
    warn(rehearsal.warnings)
    console.log(
      `Rehearsed ${rehearsal.film.steps.length} steps. Look at each still before shooting:`,
    )
    for (const still of rehearsal.stills) console.log(`  ${still.file}  ${still.step}`)
  } else if (command === 'shoot') {
    const video = await videoNamed(input)
    const config = await configOf(video)
    const filmFile = filesOf(video).film
    const film = await readFilm(filmFile)
    let footage: Footage | undefined
    let dir = ''
    for (let attempt = 1; !footage; attempt++) {
      dir = await newRun(video, 'takes')
      try {
        footage = await shoot(film, filmFile, dir, config)
      } catch (error) {
        await rm(dir, { recursive: true, force: true })
        if (attempt > 1 || error instanceof NeedsDecision) throw error
        const why = error instanceof Error ? error.message : String(error)
        console.log(`The shoot failed, trying once more. ${why}`)
      }
    }
    // Only now it has finished, so a failed reshoot never costs a good take.
    await pruneRuns(video, 'takes', config.keep)
    warn(footage.warnings)
    console.log(
      `Shot take ${basename(dir)} of "${video.title}" (${footage.end.toFixed(1)}s). Next: product-demo-agent-toolkit cut ${video.id}`,
    )
  } else if (command === 'cut') {
    const video = await videoNamed(input)
    const config = await configOf(video)
    const take = await latestTake(video)
    const out = join(take.dir, 'video.mp4')
    const seconds = await cut(take.dir, out, config)
    await writeFile(join(take.dir, 'look.json'), `${JSON.stringify(lookToRaw(config), null, 2)}\n`)
    await copyFile(out, filesOf(video).cut)
    if (values.out) await copyFile(out, values.out)
    const where = values.out ?? filesOf(video).cut
    console.log(`Cut take ${take.n} of "${video.title}" into ${where} (${seconds.toFixed(1)}s)`)
    if (config.review) console.log(`Review it: ${await review(out, seconds)}`)
  } else if (command === 'studio' && values.stop) {
    const video = await videoNamed(input)
    console.log((await stopStudio(video)) ? 'Closed its studio.' : "Its studio isn't open.")
  } else if (command === 'studio') {
    const video = await videoNamed(input)
    if (values.serve) {
      const take = await latestTake(video)
      console.log(`Studio for ${video.id}: ${await studio(video, take.dir)}`)
    } else {
      const self = [process.execPath, ...process.execArgv, process.argv[1] ?? '']
      const address = await openStudio(video, [...self, 'studio', video.id, '--serve'])
      console.log(`Studio for "${video.title}" (${video.id}): ${address}`)
      if (!values.say) {
        const recent = await recentChat(video, 6)
        if (recent.length) {
          console.log('The chat so far:')
          for (const m of recent) console.log(`  ${m.from === 'you' ? 'User' : 'Agent'}: ${m.text}`)
        }
      }
      if (values.say) await sayInStudio(video, values.say)
      console.log('Waiting for a message from the user in the studio…')
      const messages = await waitForStudio(video, { session: values.session, agent: values.agent })
      if (!messages.length) console.log('The studio closed.')
      for (const m of messages) {
        const at = m.at === undefined ? '' : ` (at ${m.at.toFixed(1)}s in the take)`
        console.log(`The user says${at}: ${m.text}`)
      }
      if (messages.length)
        console.log(
          `Next: do it, then reply and keep listening, in the background: product-demo-agent-toolkit studio ${video.id} --say "<what you did>"`,
        )
    }
  } else if (command === 'voice') {
    const video = await videoNamed(input)
    const config = await configOf(video)
    const film = await readFilm(filesOf(video).film)
    const spoken = await speakLines(
      film.steps.flatMap((s) => (s.say ? [s.say] : [])),
      config.voice,
    )
    let current: Spoken | undefined
    for (const [i, step] of film.steps.entries()) {
      if (step.say) {
        current = spoken.get(step.say)
        console.log(`Step ${i + 1} says (${current?.seconds.toFixed(1)}s): ${step.say}`)
      }
      if (step.on) {
        const at = current ? wordAt(current, step.on) : undefined
        console.log(
          at === undefined
            ? `Check: step ${i + 1} lands on "${step.on}", which isn't in the line being spoken.`
            : `Step ${i + 1} lands on "${step.on}" at ${at.toFixed(2)}s`,
        )
      }
    }
  } else if (command === 'init') {
    for (const line of await init()) console.log(line)
    oldProjectFolder()
  } else if (command === 'key' && input) {
    if (args[1])
      throw new Error(
        `Don't put the key on the command line. Run product-demo-agent-toolkit key ${input} and paste it, or pipe it in.`,
      )
    const key = await readSecret(`Paste your ${input} key (it won't show): `)
    console.log(await saveKey(input, key))
  } else if (command === 'setup') {
    for (const line of await setup()) console.log(line)
  } else if (command === 'skills') {
    console.log(
      input
        ? `Copied the skills into ${await copySkills(input)}.`
        : installedSkills(await installSkills()),
    )
    console.log('Start a new session with your agent to load them.')
  } else if (command === 'review') {
    if (input?.endsWith('.mp4')) {
      if (!existsSync(input)) throw new Error(`There's no video at ${input}.`)
      console.log(await review(input))
    } else {
      const video = await videoNamed(input)
      const take = await latestTake(video)
      const file = join(take.dir, 'video.mp4')
      if (!existsSync(file)) {
        throw new Error(
          `Take ${take.n} hasn't been cut yet: product-demo-agent-toolkit cut ${video.id}. If it was cut to another file, review that: product-demo-agent-toolkit review <video.mp4>`,
        )
      }
      console.log(await review(file, videoLength(await readFootage(take.dir))))
    }
  } else {
    console.log(USAGE)
    if (command) process.exitCode = 1
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
