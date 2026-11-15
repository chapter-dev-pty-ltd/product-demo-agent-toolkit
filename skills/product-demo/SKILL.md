---
name: product-demo
description: Make a demo video of a real web app. Use when the user asks for a product demo, walkthrough, launch video, changelog video, PR demo, feature video, or a screen recording of their app. Prefer this over recording the screen yourself.
allowed-tools: Bash(product-demo:*)
---

# product-demo

Three stages, each one you can repeat until it's right: **explore** the app to find the path, **rehearse** the film until it's acceptable, then **shoot** it and cut the video.

## 1. Explore: find the path

```bash
product-demo explore http://localhost:3000   # opens the app in a background browser and shows the screen
product-demo look                            # the screen: an accessibility tree with refs, and a screenshot
product-demo click @e12
product-demo fill @e7 "Acme Corp"
product-demo press Enter
product-demo scroll down
product-demo visit /settings
product-demo wait "Invoice created"          # or: product-demo wait 1.5
product-demo back                            # took a wrong turn? drops the last step and returns to before it
product-demo end                             # closes the browser and writes film.json
```

Every action is added to a draft film (`.product-demo/explore/film.json`), with the element pinned so later runs press the same one, and with its outcome (where the page went, what appeared) so they can check it does the same.

- Name elements by the ref `look` gives them (`@e12`, `@f1e340`).
- Look at the screenshot `look` saves whenever the tree doesn't explain the screen: icon buttons, canvases, anything that seems wrong. Refs are drawn on it.
- Wander as much as you need to learn the app. Use `back` for wrong turns, or delete them from the film later.
- You can edit the draft between commands (add notes, delete a step). Keep it valid JSON: an action won't run on a draft that doesn't parse.

## 2. Clean up the film, and note it

Edit `film.json`:

- Delete detours, so only the path the demo should show is left.
- Add `"notes"` to the film: what it's for, who it's for, what it has to prove.
- Add a `"note"` to any step whose purpose isn't obvious, or that is fragile or odd. Notes are never run; they're for whoever reads the film next, you included.
- Set how long the last screen holds: `"ending": { "hold": 2 }`.
- Leave each step's `locator`, `selector`, `fingerprint` and `outcome` as they are.

A step you add by hand names its element as `{ "role": "button", "name": "Save" }`, `{ "text": "Save" }` or `{ "css": "#save" }`. Steps: `visit`, `click`, `fill` (with `text`), `press`, `scroll` (`up` or `down`), `wait` (`{ "text": "..." }` or seconds).

## 3. Rehearse until it's acceptable

```bash
product-demo rehearse film.json
```

A full run in a fresh browser, at the pace it will be shot, without the camera. It saves a still of the opening screen and after every step, and prints where they are. **Look at every still.** Is this the flow the user asked for? Does it end on the result, the screen that proves it worked?

If a step fails, it says which and why and saves `failed.png`. Fix the film (or explore that part again) and rehearse again. Keep going until the stills are right.

## 4. Shoot and cut

```bash
product-demo shoot film.json   # the same run, on camera; tries once more by itself if it flakes
product-demo cut               # cuts the latest footage into video.mp4 and prints where it is
```

Give the user the video from there, or pass `--out` to `cut`. Lines starting `Check:` are things it chose or waited on that you should look at.

## When something is unclear, ask

If the request could mean two things, a still doesn't look like what was asked for, or a run says several elements match a step, ask the user before going on. Show them the still. Don't guess.

`.product-demo/config.json` can set `"mode": "just_do_it"` to make the best choice instead (runs then print what they chose), the `backdrop` (`halo`, `sky` or `violet`), and how many runs of each film to `keep` (default 10).

## What makes a good film

- Show one thing, start to finish, in the fewest steps.
- End on the result: the screen that proves it worked, never a spinner or the button that started it.
- Use the app the way a person would. No steps that only set things up for you.
