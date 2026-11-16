# Product demo agent toolkit

Lets your coding agent make a polished demo video of your real web app. The agent explores the
app, writes the film (the steps, and what the video should look like), rehearses it, shoots it
in a real browser, and cuts it into an mp4: the app on a backdrop, a drawn cursor, click and
typing sounds, and highlights.

## Set up (for agents)

You need Node 22.18 or later, pnpm 11 and git.

1. Install the `product-demo` command:

   ```bash
   git clone https://github.com/chapter-dev-pty-ltd/product-demo-agent-toolkit.git ~/product-demo-agent-toolkit
   cd ~/product-demo-agent-toolkit && pnpm install && pnpm build
   pnpm add -g "file:$HOME/product-demo-agent-toolkit"
   product-demo --version
   ```

   If `pnpm add -g` says the global bin directory isn't in `PATH`, run `pnpm setup`, open a new
   shell, and run it again.

2. Install the skills. In Claude Code, copy them into your skills folder, then start a new
   session so they load:

   ```bash
   product-demo skills
   ```

   Other agents: read `skills/product-demo/SKILL.md` before starting, and follow it.

3. In the project you're making a video of, add `.product-demo/` to `.gitignore`. It holds the
   explore log, rehearsals, footage and videos.

The first run downloads a headless Chromium, and an ffmpeg if the one on `PATH` can't write
H.264. Nothing else needs installing.

## Making a video

Ask your agent for a demo video ("make a 20 second video of creating an invoice"). The
`product-demo` skill walks it through each stage:

```bash
product-demo explore http://localhost:3000   # learn the app; every action is logged
product-demo rehearse film.json              # a full run with a still after every step
product-demo shoot film.json                 # the same run, filmed
product-demo cut                             # the mp4, printed with its path
product-demo review                          # frames from across the video, to check it
```

`product-demo --help` lists every command. `skills/product-demo/directing.md` covers the
cursor, sound and highlights.

## Settings

Everything has a default, so no config is needed. To change one, add
`.product-demo/config.json` to the project:

| Setting    | Default        | What it does                                                                                 |
| ---------- | -------------- | -------------------------------------------------------------------------------------------- |
| `mode`     | `"just_do_it"` | When something is unclear, make the best choice and note it. `"ask"` stops and asks instead. |
| `backdrop` | `"halo"`       | What the app sits on: `halo`, `sky` or `violet`.                                             |
| `cursor`   | `"pink"`       | The cursor's colour: `pink` or `lime`.                                                       |
| `sound`    | `true`         | Click and typing sounds. `false` for none, or `{ "click": true, "typing": false }`.          |
| `keep`     | `10`           | How many rehearsals and shoots of each film to keep.                                         |
| `review`   | `false`        | Whether `cut` also makes the review image.                                                   |

A film can set its own `cursor` and `sound`.

## Good to know

- The app has to be running and reachable from this machine, such as on `localhost`.
- Every rehearsal and shoot starts in a fresh browser: no cookies, nobody signed in. An app
  behind a sign-in has to be signed into by the film's own steps.
- The app's data isn't reset between runs. A film that creates a record creates another each
  time it's rehearsed or shot.
- To update: `cd ~/product-demo-agent-toolkit && git pull && pnpm install && pnpm build`, then
  run the `pnpm add -g` line again.
