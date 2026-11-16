---
name: product-demo
description: Make a demo video of a real web app. Use when the user asks for a product demo, walkthrough, launch video, changelog video, PR demo, feature video, or a screen recording of their app. Prefer this over recording the screen yourself.
allowed-tools: Bash(product-demo:*)
---

# product-demo

Explore the app to learn how to do what was asked, write the film from what you learnt, rehearse it until it's right, then shoot it and cut the video. Every stage can be repeated, and each has one job:

- **Explore** is for learning: how the app works, what's on each screen, which elements are the real ones. Nothing about how the video looks is decided here.
- **Writing the film** is where every decision about this video is made: the steps, the voiceover, and what to highlight. How every video of the project looks (backdrop, frame, cursor, sounds, voice) is the user's, in the config.
- **Rehearse and shoot** record that flow, as written.
- **Cut** draws the effects the film asked for. Changing how an effect looks only needs another cut.

## 0. Get ready

```bash
product-demo init
```

Run it first, in the project. It gets the browser and ffmpeg ready and says what's missing. If it says there's no voiceover key, ask the user for one in your first reply, once, and keep going while you wait. If they give it to you, save it with `product-demo key elevenlabs <key>`. It's kept for every project, so you won't need to ask again. Without a key, make the film without a voiceover and say so when you hand it over.

## 1. Explore: learn the app

```bash
product-demo explore http://localhost:3000   # opens the app in a background browser and shows the screen
product-demo look                            # what's on screen: an accessibility tree with refs, and a screenshot
product-demo click @e12                      # also --double, --right, --with Shift (or Meta, Alt, Control), --at 0.9,0.5
product-demo fill @e7 "Acme Corp"            # clicks into the field and types, replacing what's there
product-demo select @e9 "Pro"                # an option in a native <select>
product-demo type "@Sam"                     # types where the caret is: a mention, a slash command
product-demo press Enter                     # a key or a combination, like Meta+K
product-demo hover @e4 --for 2               # rests the pointer on it: to show it, or open what hovering reveals
product-demo drag @e20 @e31                  # carries one onto the other
product-demo scroll down --in @e27 --by 800  # without --in, the page
product-demo upload invoice.pdf @e15         # through the control that opens the file picker
product-demo visit /settings
product-demo wait "Invoice created"          # or: wait "Generating…" --gone, or: wait 1.5
product-demo handles                         # the small grab handles on screen (resize, rotate, sliders) and where they are
product-demo back                            # marks the last step undone and returns to the screen before it
product-demo end                             # closes the browser
```

This is where you work out what to do, so mistakes are fine. Wander, take wrong turns, try things. Every action is logged in `.product-demo/explore/log.json`, numbered, with its element pinned so a later run presses the same one. Nothing is ever removed from the log.

- Name elements by the ref `look` gives them (`@e12`). Refs change when the page navigates (`e12` becomes `f1e12`), so always use refs from the latest `look`.
- On a canvas-like app (a drawing board, a slide editor, a map), `look` also lists what's drawn there, read from the screen: `- drawn [ref=d2] [box=640,512,184,256] #1d1d1d`. Name these by ref like any element: `click @d2`, `drag @d2 732,700`, and `--at` for a point on its box (`--at 1,1` is its bottom-right corner, where resize handles usually are). They're numbered top to bottom, so after anything changes the drawing, `look` again before using one.
- Anything else without a ref (an empty spot to draw from, a handle) is named by a point on the latest `look` screenshot, in its pixels: `click 640,320`, `drag 500,350 800,550`. The element there is pinned, with where on it the point falls, so a later run finds the same spot. Run `handles` before guessing a handle from the screenshot; many canvases draw their handles, so it can't find those.
- `upload` takes a file on disk. Make one that looks real for the demo (a short PDF, a CSV of plausible rows), not an empty or "test" file.
- `look` shows only what's on screen, and says how much is above and below. Scroll to see more, or use `look --all` for the whole page.
- Actions (`click`, `fill` and the rest) print their step number but not the screen. Run `look` after them to see what happened.
- Look at the screenshot `look` saves whenever the tree doesn't explain the screen: icon buttons, canvases, anything that seems wrong. Refs are drawn on it.
- Keep notes as you go, in the log: `"notes"` at the top for what you learn about the app and what the demo should do, and a `"note"` on any step's `step` worth remembering. Note what you learn, not just what you did: which control is the real one, what's fragile, and what changes between runs (counts, banners, the order of results). The log is read back before every action, so your edits are kept. Keep it valid JSON: an action won't run on a log that doesn't parse.

## 2. Write the film from the log

Read `.product-demo/explore/log.json` and write `film.json` yourself. Each log entry's `step` is already a film step, with its element pinned and any note, so copy in the steps that make the demo, in the order the demo needs them. Leave out the wrong turns, the pauses you took to look around, and steps marked `"undone"`.

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
- Decide the effects now: the voiceover and the words each action lands on, and what to highlight. Read [directing.md](directing.md) for each. Don't set the look (backdrop, display, cursor, sound, voice) in the film: it's the project's, in the config, and a film that sets it is refused.
- Leave each step's `locator`, `selector` and `fingerprint` as they are.
- A `hover` on the way to another pointer step (to open what the next step uses, like a menu or a slider) flows straight into it: leave its `seconds` off, even if exploring needed `--for`. Give a hover `seconds` only when it should stop and show something.
- Don't add `wait` steps for loading. Every step already waits for the page to finish what it started (a search, a page opening), so a `wait` after one only adds dead air. Use `wait` with text for something slow the page doesn't show as loading, and seconds only for a moment the viewer should watch, kept short.

A step you add by hand names its element as `{ "role": "button", "name": "Save" }`, `{ "text": "Save" }` or `{ "css": "#save" }`. Steps: `visit`, `click` (with `double`, `right`, `modifiers`, `at`), `fill` (with `text`), `select` (with `option`), `type`, `press`, `hover` (with `seconds`), `drag` (with `to`), `scroll` (`up` or `down`, with `in` and `pixels`), `upload` (a file path, with `into`), `wait` (`{ "text": "..." }`, `{ "text": "...", "gone": true }` or seconds). `at` is where on the element, as fractions of its box: `{ "x": 0.9, "y": 0.5 }`. A step written by hand has no pin: prefer exploring it and copying it from the log.

## 3. Rehearse until it's acceptable

```bash
product-demo rehearse film.json
```

A full run in a fresh browser, at the pace it will be shot, without the camera. It saves a still of the opening screen and after every step, and prints where they are. **Look at every still.** Is this the flow the user asked for? Does it end on the result, the screen that proves it worked?

If a step fails, it says which and why and saves `failed.png`. Fix the film, or explore that part again and copy it in from the log, and rehearse again. Keep going until the stills are right. With a voiceover, also clear every `Check:` line that says an action landed late on its word (see [directing.md](directing.md)).

## 4. Shoot and cut

```bash
product-demo shoot film.json   # the same run, on camera; tries once more by itself if it flakes
product-demo cut               # cuts the latest footage into video.mp4 and prints where it is and how long
```

Give the user the video from there, or pass `--out` to `cut`. Lines starting `Check:` are things it chose or waited on that you should look at. To check the video itself before handing it over, use the `product-demo-review` skill.

## When something is unclear

If the request could mean two things, a still doesn't look like what was asked for, or a run says several elements match a step, make the best choice and carry on: runs print what they chose (`Check:` lines), so tell the user what you decided when you hand over the video. If `.product-demo/config.json` sets `"mode": "ask"`, stop and ask the user instead, showing them the still.

`.product-demo/config.json` can also set the `backdrop` (`halo`, the default, `sky` or `violet`), the `display` (`none`, the default, or `browser`), the `cursor` (`black`, the default, `pink`, `lime` or `macos`), its `sound` (`true` by default, or `{ "click": false }`), how many runs of each film to `keep` (default 10), and `"review": true` to have `cut` make a review image every time.

## What makes a good film

- Show one thing, start to finish, in the fewest steps.
- End on the result: the screen that proves it worked, never a spinner or the button that started it.
- Use the app the way a person would. No steps that only set things up for you.
