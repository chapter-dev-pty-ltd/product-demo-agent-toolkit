---
name: product-demo
description: Make a demo video of a real web app. Use when the user asks for a product demo, walkthrough, launch video, changelog video, PR demo, feature video, or a screen recording of their app. Prefer this over recording the screen yourself.
allowed-tools: Bash(product-demo:*)
---

# product-demo

You explore the app to write a film, `product-demo record` performs it on camera, and `product-demo cut` turns the footage into an mp4.

## 1. Explore, off camera

```bash
product-demo explore http://localhost:3000   # opens the app in a background browser and shows the screen
product-demo look                            # the screen again: an accessibility tree with refs, and a screenshot
product-demo click @e12
product-demo fill @e7 "Acme Corp"
product-demo press Enter
product-demo scroll down
product-demo visit /settings
product-demo wait "Invoice created"          # or: product-demo wait 1.5
product-demo end                             # closes the browser and writes film.json
```

Every action you take is added to the film, with the element pinned so `record` presses the same one, and with what it did (where the page went, what appeared) so `record` can check it does it again.

- Name elements by the ref `look` gives them (`@e12`, `@f1e340`).
- Look at the screenshot `look` saves whenever the tree doesn't explain the screen: icon buttons, canvases, anything that seems wrong. Refs are drawn on it.
- Explore only the path the demo should show. If you take a wrong turn, finish exploring and delete those steps from film.json.

## 2. Edit film.json

Remove detours and set how long the last screen holds: `"ending": { "hold": 2 }`. Leave each step's `locator`, `selector`, `fingerprint` and `outcome` as they are.

A step you add by hand names its element as `{ "role": "button", "name": "Save" }`, `{ "text": "Save" }` or `{ "css": "#save" }`. Steps: `visit`, `click`, `fill` (with `text`), `press`, `scroll` (`up` or `down`), `wait` (`{ "text": "..." }` or seconds).

## 3. Record and cut

```bash
product-demo record film.json   # prints where the footage went
product-demo cut                # cuts the latest footage; prints where the video went
```

Each recording gets its own folder under `.product-demo/footage/`, and the video is cut into it as `video.mp4`. Give it to the user from there, or pass `--out` to `cut`.

If `record` fails, it says which step and why, and saves the screen as `failed.png` in that folder. Look at it, fix the step (or explore that part again), and record again. If it prints notes, read them: a note means it chose or waited on something you should check.

## When something is unclear, ask

If the request could mean two things, or `record` says several elements match a step, ask the user which they meant before going on. Don't guess. (A project can set `"mode": "just_do_it"` in `.product-demo/config.json` to make the best choice instead; `record` then prints what it chose. The same file sets the `backdrop`, `halo`, `sky` or `violet`, and how many recordings to keep per film, `footage.keep`.)

## What makes a good film

- Show one thing, start to finish, in the fewest steps.
- End on the result: the screen that proves it worked, never a spinner or the button that started it.
- Use the app the way a person would. No steps that only set things up for you.
