---
name: product-demo
description: Make a demo video of a real web app. Use when the user asks for a product demo, walkthrough, launch video, changelog video, PR demo, feature video, or a screen recording of their app. Prefer this over recording the screen yourself.
allowed-tools: Bash(product-demo:*)
---

# product-demo

Explore the app to learn how to do what was asked, write the film from what you learnt, rehearse it until it's right, then shoot it and cut the video. Every stage can be repeated.

## 1. Explore: learn the app

```bash
product-demo explore http://localhost:3000   # opens the app in a background browser and shows the screen
product-demo look                            # what's on screen: an accessibility tree with refs, and a screenshot
product-demo click @e12
product-demo fill @e7 "Acme Corp"
product-demo press Enter
product-demo scroll down
product-demo visit /settings
product-demo wait "Invoice created"          # or: product-demo wait 1.5
product-demo back                            # marks the last step undone and returns to the screen before it
product-demo end                             # closes the browser
```

This is where you work out what to do, so mistakes are fine. Wander, take wrong turns, try things. Every action is logged in `.product-demo/explore/log.json`, numbered, with its element pinned (so a later run presses the same one) and its outcome (where the page went, what appeared, so a later run can check it does the same). Nothing is ever removed from the log.

- Name elements by the ref `look` gives them (`@e12`). Refs change when the page navigates (`e12` becomes `f1e12`), so always use refs from the latest `look`.
- `look` shows only what's on screen, and says how much is above and below. Scroll to see more, or use `look --all` for the whole page.
- Actions (`click`, `fill` and the rest) print their step number but not the screen. Run `look` after them to see what happened.
- Look at the screenshot `look` saves whenever the tree doesn't explain the screen: icon buttons, canvases, anything that seems wrong. Refs are drawn on it.
- Keep notes as you go, in the log: `"notes"` at the top for what you learn about the app and what the demo should do, and a `"note"` on any step's `step` worth remembering. The log is read back before every action, so your edits are kept. Keep it valid JSON: an action won't run on a log that doesn't parse.

## 2. Write the film from the log

```bash
product-demo log                    # the log's steps, numbered
product-demo compose 2 3 7          # starts film.json from those steps, in that order
```

Choose the steps that make the demo, and only those: none of the wrong turns, pauses you took to look around, or steps marked undone. `compose` copies them with their pins, outcomes and notes. Then edit `film.json`:

- Add `"notes"` to the film: what it's for, who it's for, what it has to prove.
- Add a `"note"` to any step whose purpose isn't obvious, or that is fragile or odd. Notes are never run; they're for whoever reads the film next, you included.
- Set how long the last screen holds, in seconds: `"ending": { "hold": 2 }` (2 if you leave it out).
- Leave each step's `locator`, `selector`, `fingerprint` and `outcome` as they are.

A step you add by hand names its element as `{ "role": "button", "name": "Save" }`, `{ "text": "Save" }` or `{ "css": "#save" }`. Steps: `visit`, `click`, `fill` (with `text`), `press`, `scroll` (`up` or `down`), `wait` (`{ "text": "..." }` or seconds). A step written by hand has no pin and no outcome, so rehearse and shoot can't check it pressed the right thing: prefer exploring it and composing it from the log.

## 3. Rehearse until it's acceptable

```bash
product-demo rehearse film.json
```

A full run in a fresh browser, at the pace it will be shot, without the camera. It saves a still of the opening screen and after every step, and prints where they are. **Look at every still.** Is this the flow the user asked for? Does it end on the result, the screen that proves it worked?

If a step fails, it says which and why and saves `failed.png`. Fix the film, or explore that part again and compose it in, and rehearse again. Keep going until the stills are right.

## 4. Shoot and cut

```bash
product-demo shoot film.json   # the same run, on camera; tries once more by itself if it flakes
product-demo cut               # cuts the latest footage into video.mp4 and prints where it is and how long
```

Give the user the video from there, or pass `--out` to `cut`. Lines starting `Check:` are things it chose or waited on that you should look at. To check the video itself before handing it over, use the `product-demo-review` skill.

## When something is unclear, ask

If the request could mean two things, a still doesn't look like what was asked for, or a run says several elements match a step, ask the user before going on. Show them the still. Don't guess.

`.product-demo/config.json` can set `"mode": "just_do_it"` to make the best choice instead (runs then print what they chose), the `backdrop` (`halo`, the default, `sky` or `violet`), how many runs of each film to `keep` (default 10), and `"review": true` to have `cut` make a review image every time.

## What makes a good film

- Show one thing, start to finish, in the fewest steps.
- End on the result: the screen that proves it worked, never a spinner or the button that started it.
- Use the app the way a person would. No steps that only set things up for you.
