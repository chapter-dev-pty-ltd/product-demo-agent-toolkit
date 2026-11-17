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

## Why not just ask your agent to record the screen?

An agent can already drive a browser. What comes out isn't a video anyone wants to watch:

- **It moves like a robot.** The pointer jumps from place to place, text appears all at once,
  and nothing pauses for the viewer. The toolkit moves the pointer the way a hand does, types
  at a person's pace, and gives each result a moment on screen.
- **It doesn't know when the page is ready.** It either waits too long, filling the video
  with dead air, or acts too early, mid-load. The toolkit watches the screen itself, so it
  waits for what's loading and not a moment longer.
- **It has no cursor, sound or framing.** A raw recording is a bare screen. The toolkit draws
  a cursor that dips on every click, plays real click and keyboard sounds, and frames the app
  on a backdrop or in a browser window.
- **Its voiceover can't keep time.** Narration added afterwards never lines up. Here, the
  lines are spoken first and every click, keystroke and drag lands on its word.
- **Every change means starting again.** Here, the look is drawn after shooting, so changing
  the cursor, a highlight or the framing is a re-cut in seconds, not another take.

And it runs locally: your agent, your app, your machine. Nothing is uploaded.

## Good visuals by default

Every video looks finished with no setup:

- 1080p at 60fps, the app crisp on a soft backdrop.
- A drawn cursor that glides between targets and dips as it clicks.
- Real click and keyboard sounds on every click and keystroke, with space and Enter their own.
- Highlights that zoom in smoothly on what matters.
- An optional browser window, frosted over the backdrop, with an address bar that follows the
  page.

## Config

Everything has a default, so no config is needed. To change one, add
`.product-demo/config.json` to the project:

| Setting    | Default                  | What it does                                                                                                                      |
| ---------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `mode`     | `"just_do_it"`           | When something is unclear, make the best choice and note it. `"ask"` stops and asks instead.                                      |
| `backdrop` | `"halo"`                 | What the app sits on: `halo`, `sky` or `violet`.                                                                                  |
| `display`  | `"none"`                 | How the app is shown: `none`, on the backdrop as it is, or `browser`, in a browser window with an address bar.                    |
| `cursor`   | `"black"`                | The cursor: `black`, `pink`, `lime` or `macos`, or with a size and a label: `{ "style": "pink", "size": 1.5, "label": "Agent" }`. |
| `sound`    | `true`                   | Click and typing sounds. `false` for none, or `{ "click": true, "typing": false }`.                                               |
| `voice`    | Jessica, from ElevenLabs | Who speaks the voiceover: `{ "provider": "elevenlabs", "voice": "<voice id>" }`.                                                  |
| `keep`     | `10`                     | How many rehearsals and shoots of each film to keep.                                                                              |
| `review`   | `false`                  | Whether `cut` also makes the review image.                                                                                        |

These apply to every video of the project. A film can't override them.

## Features

1. Explores your app first, then films it from a script you can read and edit.
2. Moves, types and waits like a person, not a robot.
3. Voiceover timed to the word.
4. Highlights, zoom, cursors, sounds and a browser frame, drawn after shooting.
5. Works on canvas apps like Excalidraw, tldraw and draw.io.

## Coming soon

- Speed ramps: play a stretch at 2x, with a badge so viewers know.
- Captions, and a badge for keyboard shortcuts as they're pressed.
- Background music.
- GIF and poster exports for docs and social posts.
- Staying signed in between runs, for apps behind a login.
- Windows support.

## Licence

MIT. The sounds are CC0, credited in [library/README.md](library/README.md).
