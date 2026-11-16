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
performs to the voice: the line starts with its step, the pointer gets there early and presses
(or starts typing) as the word is said, and the film moves on once the line has finished. One
line can carry several actions: the steps after it give their own `"on"` and no `"say"`. A
step with neither waits for the line to end, then runs.

```json
{ "press": "r", "say": "Press R for the rectangle tool, and drag out a box.", "on": "R" },
{ "drag": …, "on": "drag" },
{ "press": "Enter", "say": "Enter again, and call this one ship it.", "on": "enter" },
{ "type": "Ship it", "on": "ship" },
{ "press": "Escape" }
```

### Writing lines that land

- Write the lines with the steps in front of you, after exploring: say what the viewer is
  about to see happen, in the order it happens.
- Put `on` on the word that names the action: "**press** enter", "**drag** out a box",
  "**select** the box", "give it some **colour**". For typing, put it on the word that matches
  what's typed ("call this one **ship** it" as "Ship it" is typed), so the text appears as
  it's said. A key is written as its letter, "Press R", with `"on": "R"`.
- Leave room before each `on`. The action before it has to finish first, and the pointer has
  to get there: allow about a second after a drag, a typed label (a tenth of a second a
  letter), a page change, or a click that opens a panel, and half a second for the pointer to
  cross the screen. Don't put the first `on` of a line in its first half second if the
  pointer has far to go.
- To make room, add words before the word, not after: "Then, starting at the idea, drag it
  across" lands better than "and drag it from the idea across". Splitting a long line into
  two is fine too.
- Short, plain lines, about 2.6 words a second: full stops and commas, no em dashes, an
  exclamation mark only in a greeting. "You" or "we", never "as you can see".
- Steps that don't need a word, like closing a panel with Escape, go after the line with no
  `say` or `on`. End on a short closing line, on the last step, with no `on`.

### Checking it

1. `product-demo voice film.json` speaks the lines (once; a line that hasn't changed isn't
   spoken again) and shows when each `on` word lands in its line. Every `on` must be found.
2. `product-demo rehearse film.json` runs at the voice's pace. A line like
   `Check: Step 12 … landed 0.7s after "drag" was said` means that action had too little room:
   add words before its word, and rehearse again. Keep going until there are none, or only a
   few tenths of a second.

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
