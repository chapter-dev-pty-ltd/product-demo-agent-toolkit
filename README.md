# <img src="docs/logo.svg" alt="Chapter" height="36" align="absmiddle"> product-demo-agent-toolkit

### A toolkit to make beautiful product videos with your own agent

Create product videos that your customers love, with your own AI agent, and let the toolkit
handle all of the common issues that agents run into while creating demos.

<!--
  Looping demo video goes here. GitHub doesn't autoplay <video> in a README, so for a loop use a
  GIF (or an animated WebP), kept under 10MB:
  ![A demo video made with the toolkit](docs/demo.gif)
-->

![A product video made with the toolkit](docs/hero.webp)

## Quickstart

```bash
npx @chapterdev/product-demo-agent-toolkit setup
```

Now ask your agent to create a product demo for you:

> Make a 20 second demo video of creating an invoice.

## Why do I need a toolkit?

Although your agent can drive your browser and navigate your product, we've found that it makes
certain decisions that just aren't acceptable if you want to send these videos to customers,
such as:

- **It moves like a robot.** The pointer jumps from place to place, text appears all at once,
  and nothing pauses for the viewer. The toolkit moves the pointer the way a hand does, types
  at a person's pace, and gives each result a moment on screen.
- **It doesn't know when the page is ready.** It either waits too long, filling the video
  with dead air, or acts too early, mid-load. The toolkit watches the screen itself, so it
  waits for what's loading and not a moment longer.
- **Unnatural narratives.** Left to itself, an agent makes up scenarios no real user would
  go through, with made-up data and steps that don't match how your product is used. The
  toolkit has it explore your app first, then write a script you can read and edit.
- **Voiceovers are out of sync.** Narration added afterwards never lines up. Here, the
  lines are spoken first and every click, keystroke and drag lands on its word.

So we built a toolkit to address these issues and much more.

## Tasteful Defaults

![The cursors (macOS, black, pink, lime, and any hex colour with an Agent label) and the backgrounds (halo, sky, violet and more)](docs/defaults.webp)

As well as:

- Background music that doesn't put your audience to sleep.
- Frames (browser, rounded borders).
- Cursor movement that feels like a real human.
- Real clicking & typing sounds.
- 1080p at 60fps.

## Customizable Config

The toolkit is ready to roll by default, but if you want to customize it, you can do that too!
Add `.product-demo/config.json` to the project:

| Setting    | Default                  | What it does                                                                                                                                                          |
| ---------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`     | `"just_do_it"`           | When something is unclear, make the best choice and note it. `"ask"` stops and asks instead.                                                                          |
| `backdrop` | `"halo"`                 | What the app sits on: `halo`, `sky` or `violet`.                                                                                                                      |
| `display`  | `"none"`                 | How the app is shown: `none`, on the backdrop as it is, or `browser`, in a browser window with an address bar.                                                        |
| `cursor`   | `"black"`                | The cursor: `black`, `pink`, `lime`, `macos` or any hex colour like `"#8fd3ff"`, or with a size and a label: `{ "style": "#8fd3ff", "size": 1.5, "label": "Agent" }`. |
| `sound`    | `true`                   | Click and typing sounds. `false` for none, or `{ "click": true, "typing": false }`.                                                                                   |
| `voice`    | Jessica, from ElevenLabs | Who speaks the voiceover: `{ "provider": "elevenlabs", "voice": "<voice id>" }`.                                                                                      |
| `keep`     | `10`                     | How many rehearsals and shoots of each film to keep.                                                                                                                  |
| `review`   | `false`                  | Whether `cut` also makes the review image.                                                                                                                            |

## Features

- Human feeling movement and navigation
- Voiceovers sync naturally to actions
- Highlight specific DOM elements
- Smooth camera zoom and panning
- Tasteful cursors, backdrops and audio defaults
- Handcrafted skills for how to produce great videos
- Built-in review infrastructure
- High definition recording functionality

And much more.

#### Coming soon

- Local Studio (web application for editing)
- Support for Safari and Firefox (currently only Chrome)
- More tasteful defaults

## Licence

MIT. The sounds are CC0, credited in [library/README.md](library/README.md).
