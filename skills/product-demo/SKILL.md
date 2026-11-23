---
name: product-demo
description: Make a demo video of a real web app. Use when the user asks for a product demo, walkthrough, launch video, changelog video, PR demo, feature video, or a screen recording of their app. Prefer this over recording the screen yourself.
allowed-tools: Bash(product-demo-agent-toolkit:*)
---

# product-demo

Start a video, explore the app to learn how to do what was asked, write the film from what you learnt, rehearse it until it's right, then shoot it and cut the video. Every stage can be repeated, and each has one job:

- **Explore** is for learning: how the app works, what's on each screen, which elements are the real ones. Nothing about how the video looks is decided here.
- **Writing the film** is where every decision about what the video shows is made: the steps, the voiceover, and what to highlight. How it looks (backdrop, frame, cursor, sounds, music) is the video's look, which the user changes in the studio.
- **Rehearse and shoot** record that flow, as written.
- **Cut** draws the effects the film asked for. Changing how an effect looks only needs another cut.

## 0. Get ready

```bash
product-demo-agent-toolkit init
```

Run it first. It gets the browser and ffmpeg ready and says what's missing. A voiceover is optional. If it says there's no voiceover key, or that the key doesn't work, ask the user for one in your first reply, once, and keep going while you wait: don't stop for it, and don't try a key that was turned down again. If they give it to you, pipe it in so it stays off the command line: `printf %s '<key>' | product-demo-agent-toolkit key elevenlabs`. It's kept for every video, so you won't need to ask again. Without a key that works, make the film without a voiceover and say so when you hand it over.

## 1. Start the video

```bash
product-demo-agent-toolkit new "<what it shows, like: Create an invoice>" --session "<this session's name>"
```

It prints the video's **id**, six letters and digits like `k7f3q2`. **Every command from here on starts with that id**, and everything for the video is kept in its folder, `~/.product-demo/videos/<id>/`: its film, its look, its takes, its cut and its studio chat. Give it a title that says what it shows; without one it takes the session's name.

To work on a video that already exists (made earlier, by you or another session), don't make a new one: `product-demo-agent-toolkit videos` lists them all with their ids and titles, and any command takes the id, or words from the title.

## 2. Explore: learn the app

```bash
product-demo-agent-toolkit explore <id> http://localhost:3000   # opens the app in a background browser and shows the screen
product-demo-agent-toolkit look <id>                            # what's on screen: an accessibility tree with refs, and a screenshot
product-demo-agent-toolkit click <id> @e12                      # also --double, --right, --with Shift (or Meta, Alt, Control), --at 0.9,0.5
product-demo-agent-toolkit fill <id> @e7 "Acme Corp"            # clicks into the field and types, replacing what's there
product-demo-agent-toolkit select <id> @e9 "Pro"                # an option in a native <select>
product-demo-agent-toolkit type <id> "@Sam"                     # types where the caret is: a mention, a slash command
product-demo-agent-toolkit press <id> Enter                     # a key or a combination, like Meta+K
product-demo-agent-toolkit hover <id> @e4 --for 2               # rests the pointer on it: to show it, or open what hovering reveals
product-demo-agent-toolkit drag <id> @e20 @e31                  # carries one onto the other
product-demo-agent-toolkit scroll <id> down --in @e27 --by 800  # without --in, the page
product-demo-agent-toolkit upload <id> invoice.pdf @e15         # through the control that opens the file picker
product-demo-agent-toolkit visit <id> /settings
product-demo-agent-toolkit wait <id> "Invoice created"          # or: wait <id> "Generating…" --gone, or: wait <id> 1.5
product-demo-agent-toolkit handles <id>                         # the small grab handles on screen (resize, rotate, sliders) and where they are
product-demo-agent-toolkit back <id>                            # marks the last step undone and returns to the screen before it
product-demo-agent-toolkit end <id>                             # closes the browser
```

This is where you work out what to do, so mistakes are fine. Wander, take wrong turns, try things. Every action is logged in the video's `explore/log.json`, numbered, with its element pinned so a later run presses the same one. Nothing is ever removed from the log.

- Name elements by the ref `look` gives them (`@e12`), after the video's id. Refs change when the page navigates (`e12` becomes `f1e12`) or redraws part of itself (a search box that turns into a list as you type), so always use refs from the latest `look`.
- On a canvas-like app (a drawing board, a slide editor, a map), `look` also lists what's drawn there, read from the screen: `- drawn [ref=d2] [box=640,512,184,256] #1d1d1d`. Name these by ref like any element: `click @d2`, `drag @d2 732,700`, and `--at` for a point on its box (`--at 1,1` is its bottom-right corner, where resize handles usually are). They're numbered top to bottom, so after anything changes the drawing, `look` again before using one.
- Anything else without a ref (an empty spot to draw from, a handle) is named by a point on the latest `look` screenshot, in its pixels: `click 640,320`, `drag 500,350 800,550`. The element there is pinned, with where on it the point falls, so a later run finds the same spot. Run `handles` before guessing a handle from the screenshot; many canvases draw their handles, so it can't find those.
- `upload` takes a file on disk. Make one that looks real for the demo (a short PDF, a CSV of plausible rows), not an empty or "test" file.
- `look` shows only what's on screen, and says how much is above and below. Scroll to see more, or use `look --all` for the whole page.
- Actions (`click`, `fill` and the rest) print their step number but not the screen. Run `look` after them to see what happened.
- Look at the screenshot `look` saves whenever the tree doesn't explain the screen: icon buttons, canvases, anything that seems wrong. Refs are drawn on it.
- Keep notes as you go, in the log: `"notes"` at the top for what you learn about the app and what the demo should do, and a `"note"` on any step's `step` worth remembering. Note what you learn, not just what you did: which control is the real one, what's fragile, and what changes between runs (counts, banners, the order of results). The log is read back before every action, so your edits are kept. Keep it valid JSON: an action won't run on a log that doesn't parse.

## 3. Write the film from the log

Read the video's log, `~/.product-demo/videos/<id>/explore/log.json`, and write its film yourself, beside it: `~/.product-demo/videos/<id>/film.json`. Each log entry's `step` is already a film step, with its element pinned and any note, so copy in the steps that make the demo, in the order the demo needs them. Leave out the wrong turns, the pauses you took to look around, and steps marked `"undone"`.

```json
{
  "app": "<the log's app>",
  "notes": "What the film is for and what it has to show.",
  "steps": [ <the chosen entries' "step" objects> ],
  "ending": { "hold": 2 }
}
```

Then:

- Add `"notes"` to the film: what it's for, who it's for, what it has to prove.
- Add a `"note"` to any step whose purpose isn't obvious, or that is fragile or odd. Notes are never run; they're for whoever reads the film next, you included.
- Set how long the last screen holds, in seconds: `"ending": { "hold": 2 }` (2 if you leave it out).
- When the demo has distinct parts (asked for, or two features in one video), write `"scenes"` instead of `"steps"`: `"scenes": [{ "title": "Create a project", "cover": { "subtitle": "In under a minute", "hold": 2.5 }, "steps": [ ... ] }, ...]`. A scene with a `cover` opens on a title card for `hold` seconds (2.5 if left out); leave `cover` off to run straight into it. The scenes are shot as one run, so each picks up where the last left off: start one with a `visit` if it needs another page. A cover's words and hold change with just another cut; moving where a scene starts needs another shoot. Covers show in the cut video, not yet in the studio. When the user wants covers designed differently, write the video an HTML cover of its own: see Scene covers in [directing.md](directing.md).
- Decide the effects now: the voiceover and the words each action lands on, and what to highlight. Read [directing.md](directing.md) for each. Don't set the look (backdrop, display, cursor, sound, music, cover) in the film: it's the video's, in its `look.json`, and a film that sets it is refused.
- Leave each step's `locator`, `selector` and `fingerprint` as they are.
- A `hover` on the way to another pointer step (to open what the next step uses, like a menu or a slider) flows straight into it: leave its `seconds` off, even if exploring needed `--for`. Give a hover `seconds` only when it should stop and show something.
- Don't add `wait` steps for loading. Every step already waits for the page to finish what it started (a search, a page opening), so a `wait` after one only adds dead air. Use `wait` with text for something slow the page doesn't show as loading, and seconds only for a moment the viewer should watch, kept short.

A step you add by hand names its element as `{ "role": "button", "name": "Save" }`, `{ "text": "Save" }` or `{ "css": "#save" }`. Steps: `visit`, `click` (with `double`, `right`, `modifiers`, `at`), `fill` (with `text`), `select` (with `option`), `type`, `press`, `hover` (with `seconds`), `drag` (with `to`), `scroll` (`up` or `down`, with `in` and `pixels`), `upload` (a file path, with `into`), `wait` (`{ "text": "..." }`, `{ "text": "...", "gone": true }` or seconds). `at` is where on the element, as fractions of its box: `{ "x": 0.9, "y": 0.5 }`. A step written by hand has no pin: prefer exploring it and copying it from the log.

## 4. Rehearse until it's acceptable

```bash
product-demo-agent-toolkit rehearse <id>
```

A full run in a fresh browser, at the pace it will be shot, without the camera. It saves a still of the opening screen and after every step, and prints where they are. **Look at every still.** Is this the flow the user asked for? Does it end on the result, the screen that proves it worked?

If a step fails, it says which and why and saves `failed.png`. Fix the film, or explore that part again and copy it in from the log, and rehearse again. Keep going until the stills are right. With a voiceover, also clear every `Check:` line that says an action landed late on its word (see [directing.md](directing.md)).

## 5. Shoot and cut

```bash
product-demo-agent-toolkit shoot <id>   # a new take: the same run, on camera; tries once more by itself if it flakes
product-demo-agent-toolkit cut <id>     # cuts the latest take into the video's video.mp4 and prints where it is and how long
```

Give the user the video from there, or pass `--out` to `cut`. A reshoot is a new take; the video keeps its last few. Lines starting `Check:` are things it chose or waited on that you should look at. To check the video itself before handing it over, use the `product-demo-review` skill.

### Cuts and speed-ups

Cutting a part out or speeding one up is part of the film: a step can be `"cut": true` or `"speed": 4` (2 to 16), or only part of it, in seconds from the step's start: `"cut": { "from": 1.5 }`, `"speed": { "by": 4, "to": 3 }`. A step is cut or sped up, not both. The camera still films every step as it is, so these only need another `cut`, and they carry over to a reshoot. When the user names a part by the video's clock (as the studio shows it, and as a studio message's `at` gives it), let the command work out the steps:

```bash
product-demo-agent-toolkit edit <id> cut 0:12-0:18       # cut out 0:12 to 0:18
product-demo-agent-toolkit edit <id> speed 4 0:20-0:31   # play 0:20 to 0:31 four times as fast
product-demo-agent-toolkit edit <id>                     # list them by step; --clear takes them all away
```

It writes them into the film, and the studio shows them straight away. A take shot before this version doesn't know when its steps started: shoot it again before cutting it.

For example, the studio brings you:

```text
The user says (at 0:12.0 in the video): speed this bit up, it's just loading
```

If the message doesn't say where the part ends, ask, or end it where the next step begins. Then:

```bash
product-demo-agent-toolkit edit <id> speed 4 0:12-0:20
```

```text
  Steps 4–5: 4× from 0:12.0 to 0:14.0 (8.0s of the take)
Take 2 of "Search Wikipedia" runs 21.4s. The studio shows changes as they're made; cut it again for the video.
```

The part spanned two steps, so the film now holds a speed-up on each, which you can also write or change by hand:

```json
{ "wait": { "text": "Results" }, "speed": { "by": 4, "from": 0.6 } },
{ "click": { "role": "link", "name": "Doc Watson" }, "speed": { "by": 4, "to": 1.2 } }
```

- A step holds one cut or speed-up. A part that runs into a step that already has one is refused: change or remove that one first (`edit <id>` lists them).
- The ending's hold is part of the last step, so an edit over all of that step also shortens the ending.

To silence one step's sounds, give it `"sound": false`, or `"sound": { "click": false }` for its clicks alone, as when the user asks to lose one noisy click:

```json
{ "click": { "role": "button", "name": "Search" }, "sound": { "click": false } }
```

`"sound"` in the look turns them off for the whole video instead.

## 6. The studio: change it with the user

```bash
product-demo-agent-toolkit studio <id> --session "<this session's name>" --agent "<your name>"   # in the background
```

When the user wants to see the video, change its look, or work on it with you, open its studio. It opens the video's latest take at a local address: give that to the user. Each video has its own studio and its own chat, so open the one for the video you're working on. The studio is a chat with you, so keep this loop going for as long as it's open:

1. **Listen, in the background.** Run `studio <id>` with your session's name and your own as above. It waits for the user's next message in that video's studio, prints it and exits, and its exit is what brings the message to you. Run it in the background every time: in the foreground it blocks you until the user writes. When you come to a video fresh, it also prints the chat so far: read it, it's what was asked before.
2. **Do what the message asks.** Edits to the video's `look.json` and `film.json`, and `edit` commands, show in the studio as soon as you save them. For anything slow, like a reshoot, say so first (step 3), then do it.
3. **Reply, which also listens again.** `studio <id> --say "<what you did, in a line>"`, in the background. Reply to every message, even with nothing to change: a message counts as read only once you reply, so without one the next `studio` gives it to you again.

If `studio` prints `The studio closed.`, it was closed (`studio <id> --stop`, or a reshoot moving it to the new take): only start it again if the user still wants it. After a reshoot, the next `studio <id>` opens the new take. If you aren't woken when a background command ends, run `studio <id>` whenever the user says they've written in the studio: it returns their messages straight away.

## When something is unclear

If the request could mean two things, a still doesn't look like what was asked for, or a run says several elements match a step, make the best choice and carry on: runs print what they chose (`Check:` lines), so tell the user what you decided when you hand over the video. If `~/.product-demo/config.json` sets `"mode": "ask"`, stop and ask the user instead, showing them the still.

## The look

A new video takes a copy of the default look, `~/.product-demo/config.json`, into its own `look.json`. From then on the video's look is its own: change it there (or the user does, in the studio), and a later change to the default never touches it. To change how every new video looks, change the default. Both set the `backdrop` (`sky`, the default, or `halo`, `violet`, `orchid`, `dusk-halo`, `dusk-mesh`, `dusk-corners`, `dusk-fade`, `glacier-halo`, `glacier-mesh`, `glacier-wave`, `glacier-fade`, `citrus-halo`, `citrus-warp`, `citrus-corners`, `citrus-fade`, `graphite-halo`, `graphite-mesh`, `graphite-sphere`, `graphite-fade`, `candy-clouds` or `peach-dawn`, a hex colour, or a picture of the user's own, by its path), the `display` (`none`, the default, or `browser`), the app's `window` (`{ "width": 1600, "height": 900, "fill": 0.92 }` by default: its size in the browser, which needs a new shoot to change, and how much of the video it fills, which only needs a cut, and optionally where it sits: `x` and `y` are its top-left corner, frame included, in the 1920x1080 video, centred on any axis left out, and may go negative or past the edge to let it hang off, like `"y": -120`), the `cursor` (`black`, the default, `pink`, `lime`, `macos` or any hex colour like `"#8fd3ff"`, or an SVG of the user's own, by its path, or with a size, a label beside it, and for an SVG the `tip` as [x, y] in it: `{ "style": "/Users/sam/acme/brand/cursor.svg", "tip": [2, 2], "size": 1.5, "label": "Agent" }`). A path is relative to the file it's in, so give the full path to a file in the user's project. When the user wants their brand on the video, use their colour as the cursor's hex (from their CSS) and any backdrop or cursor they give you, its `sound` (`true` by default, or `{ "click": false }`), background `music` (`false`, the default, `lofi`, the path to an audio file, or `{ "track": "lofi", "volume": 0.4 }`; it loops when the video is longer and fades out at the end), and only in the default config: how many rehearsals and takes of each video to `keep` (default 5), the `voice`, and `"review": true` to have `cut` make a review image every time.

## What makes a good film

- Show one thing, start to finish, in the fewest steps.
- End on the result: the screen that proves it worked, never a spinner or the button that started it.
- Use the app the way a person would. No steps that only set things up for you.
