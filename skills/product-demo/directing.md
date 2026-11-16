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

Give a step a line with `"say"`, and name the word its action lands on with `"on"`. The shoot
performs to the voice: the line starts with its step, the hand gets there early and presses
(or starts typing) as the word is said, and the film moves on once the line has finished. One
line can carry several actions: the next steps give their own `"on"` and no `"say"`.

```json
{ "fill": …, "text": "Book flights", "say": "First, I'll add booking our flights, and then press enter.", "on": "add" },
{ "press": "Enter", "on": "enter" },
{ "click": …, "say": "Now I'll show only what's left.", "on": "show" }
```

- Run `product-demo voice film.json` after writing the lines: it speaks them (once; a line
  that hasn't changed isn't spoken again), says how long each runs, and when each `on` lands.
- Leave room before each `on`: an action can't start until the one before it has finished
  (typing a long name, a page loading). If one lands late, rehearse says so with a `Check:`
  line; add words before it, or split the line.
- About 2.6 words a second. Short, plain lines: full stops and commas, no em dashes, an
  exclamation mark only in a greeting. Talk about what the viewer is seeing, as "you" or "we".
- The voice is Emma, from ElevenLabs. Choose another in the config or the film:
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
