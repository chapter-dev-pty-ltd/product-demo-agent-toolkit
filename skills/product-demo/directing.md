# Directing the cut

What the video looks like, as opposed to what happens in the app. These are set in
`film.json` and drawn by `product-demo cut`, so changing one never means shooting again:
edit the film, run `cut`, and the new video is ready in seconds.

## The cursor

The cut draws the cursor along the path the pointer took when the film was shot: a rounded
arrow that dips as it clicks. It comes in two colours:

- `pink`, the default.
- `lime`.

Set it for one film at its top level, `"cursor": "lime"`, or for every film in
`.product-demo/config.json`. Choose the one that stands out against the app: pink on most
apps, lime when the app is pink, red or warm-coloured, where pink gets lost. Keep one colour
for a whole film, and the same one across a set of films made together.

## Sound

The video sounds like the shot: a click on every click, and a key on every key typed, with
space and Enter their own sounds. Both are on by default. Set `"sound"` at the film's top
level, or in `.product-demo/config.json` for every film: `false` for none, or
`{ "click": true, "typing": false }` to choose each. Leave sound on unless the video will
have music or a voiceover that it would fight with.

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

Run `product-demo voice film.json` to see how long each line is and when each word comes,
then rehearse. If rehearse says an action `landed 0.7s after "drag" was said`, add a few words
before that word and rehearse again. Keep lines plain and short, about 2.6 words a second.

The voice is Emma, from ElevenLabs. Choose another in the config or the film:
`"voice": { "provider": "elevenlabs", "voice": "<voice id>" }`. It needs `ELEVENLABS_API_KEY`
in the environment or a `.env` file in the project.

## Highlights

Point the viewer at one thing, with the camera zooming toward it. Three styles:

- `"style": "box"`, the default: an outline around it, in `colour` (any hex, red if left out).
- `"style": "magnify"`: it lifts out of the screen, a little bigger, over the dimmed rest.
  Best for a row, a card or a value the viewer should read; an outline suits a control.
- `"style": "cursor"`: the cursor circles it once and comes back. For pointing at something
  without covering or changing the screen.

Put it on the step after which it should show:

```json
{ "click": { "role": "button", "name": "Save" }, "highlight": { "colour": "#2563eb", "zoom": 0.5 } }
{ "press": "Enter", "highlight": { "style": "magnify", "box": [640, 120, 400, 300] } }
```

- Without a `box`, it highlights the step's own element (for a drag, where it was dropped).
  A step with no element (`press`, `type`, `visit`, `wait`) needs a `box`: x, y, width and
  height in pixels on that step's rehearsal still.
- `zoom` runs from 0 (none, the default) to 1 (the box fills the view). 0.3 to 0.6 reads
  best; near 1 on something small gets soft.
- `seconds` is how long it holds, 2 by default. The shoot holds still for it, so changing
  it, or adding a highlight, means shooting again. Changing its style, colour, box or zoom
  only needs another cut.
- Use it for what the film is about: the result, or the one control that matters. One or
  two in a film; a highlight on every step points at nothing.
