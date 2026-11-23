# Directing the cut

What the video looks like and sounds like, as opposed to what happens in the app. Two kinds:

- **The video's look**: the backdrop, the display, the cursor, the sounds and the music. Each
  video has its own, in its `look.json` (a copy of the default it was made with), never in a
  film (a film that sets one is refused). Leave it as it is unless the user asks for a
  different look; then change the video's `look.json`, or the default for new videos.
- **The film's direction**: the voiceover lines and the highlights, written into the video's
  `film.json`.

Both are drawn by `product-demo-agent-toolkit cut`, so changing one never means shooting again: change it, run
`cut`, and the new video is ready in seconds. Only the voice is needed to shoot, since the shoot
is paced by the spoken lines.

## Display

`"display": "browser"` puts the app in a browser window: frosted glass over the backdrop, with
an address bar that follows the page's address. `"none"`, the default, shows the app on its
own.

## Scene covers

A film in scenes opens each scene that has a `cover` on a title card (see SKILL.md). The card's
design is the look's: `library/covers/default.html` unless `look.json` sets `"cover"` to an HTML
file of the project's own. Write one when the user wants covers of their own:

- It's a fragment (styles and markup, no `<html>` or `<body>`) laid over the backdrop on the
  1920x1080 frame. Fill the frame with your own background to hide the backdrop.
- `{{title}}` and `{{subtitle}}` are filled in from each scene (subtitle empty if it has none),
  so one design serves every scene.
- A scene's `colour`, `background` and `size` reach it as the CSS variables `--cover-text`,
  `--cover-background` (already behind it) and `--cover-size`: use them, with a fallback, so
  the studio's cover settings still work on your design.
- Animate with CSS `@keyframes` only, timed from the cover's start. The cut plays CSS animations
  frame by frame; scripts and timers don't run in step with it. The cut fades the cover out into
  the scene itself.
- Its styles apply to the whole stage: start every selector with a class of the cover's own.
- Pictures and fonts: a data URI or a full URL, not a path beside it.

Start from a copy of `library/covers/default.html`. A cover change needs only another `cut`.

## The cursor

The cut draws the cursor along the path the pointer took when the film was shot: a rounded
arrow with a white edge that dips as it clicks, in three colours, or a Mac's pointer:

- `black`, the default.
- `pink`.
- `lime`.
- `macos`: a classic pointer, black with a white edge, like the one on a Mac.

`{ "style": "macos", "size": 1.5 }` sets its size too: `1` is its own size, `1.5` half as big
again. Black reads on
almost any app. Pink or lime stand out more, on a dark app for instance: lime
where pink gets lost, on a pink, red or warm-coloured app.

## Sound

The video sounds like the shot: a click on every click, and a key on every key typed, with
space and Enter their own sounds. Both are on by default. `"sound": false` in the config turns
them off, or `{ "click": true, "typing": false }` chooses each. That's for the whole video: to
silence one step, give that step `"sound"` in the film instead (see Cuts and speed-ups in
SKILL.md).

## Voiceover

Write the voiceover with the steps, after exploring. Give a step a line with `"say"`, and mark
the word in it that its action lands on with `"on"`: the shoot plays the line from the start of
that step, and presses, types or drags exactly as that word is said. One line can carry
several actions (later steps give an `"on"` and no `"say"`), and the film waits for a line to
finish before the next step without an `"on"`.

Choose the word that names what happens, and leave a second or so before it for the action
before it to finish and the pointer to get there. Here, a guide to drawing a flowchart in
Excalidraw:

```json
{ "press": "r", "say": "Let's sketch a quick flowchart. Press R for the rectangle tool, and drag out a box.", "on": "R" },
{ "drag": …, "on": "drag" },
{ "press": "Enter", "say": "Enter again, and call this one ship it.", "on": "enter" },
{ "type": "Ship it", "on": "ship" },
{ "press": "Escape" },
{ "press": "a", "say": "Now press A for an arrow. Then, starting at the idea, drag it across to shipping it.", "on": "A" },
{ "drag": …, "on": "drag" },
{ "press": "Escape", "say": "And that's a flowchart, done in under a minute." }
```

"Ship it" is typed as she says "ship". "Then, starting at the idea" is there to give the
pointer time to reach the arrow's start before "drag".

Run `product-demo-agent-toolkit voice <id>` to see how long each line is and when each word comes,
then rehearse. If rehearse says an action `landed 0.7s after "drag" was said`, add a few words
before that word and rehearse again. Keep lines plain and short, about 2.6 words a second.

The voice is Jessica, from ElevenLabs, unless the config chooses another:
`"voice": { "provider": "elevenlabs", "voice": "<voice id>" }`. It needs an ElevenLabs key
(`product-demo-agent-toolkit init` says whether there is one).

## Highlights

Point the viewer at one thing, with the camera zooming toward it. Three styles:

- `"style": "box"`, the default: an outline around it, in `colour` (any hex, red if left out).
- `"style": "magnify"`: it lifts out of the screen, a little bigger, over the dimmed rest.
  Best for a row, a card or a value the viewer should read; an outline suits a control.
- `"style": "cursor"`: the cursor circles it once and comes back. For pointing at something
  without covering or changing the screen.

Put it on the step whose action it should show. It comes on as that step starts, so the
action happens inside it, then holds after:

```json
{ "click": { "role": "button", "name": "Save" }, "highlight": { "colour": "#2563eb", "zoom": 0.5 } }
{ "press": "Enter", "highlight": { "style": "magnify", "box": [640, 120, 400, 300] } }
```

- Without a `box`, it highlights the step's own element (for a drag, where it was dropped).
  A step with no element (`press`, `type`, `visit`, `wait`) needs a `box`: x, y, width and
  height in pixels on that step's rehearsal still.
- `zoom` runs from 0 (none, the default) to 1 (the box fills the view, up to 2x: closer gets
  soft). 0.3 to 0.6 reads best.
- `seconds` is how long it holds after the action, 2 by default. The shoot holds still for it, so changing
  it, or adding a highlight, means shooting again. Changing its style, colour, box or zoom
  only needs another cut.
- Use it for what the film is about: the result, or the one control that matters. One or
  two in a film; a highlight on every step points at nothing.
