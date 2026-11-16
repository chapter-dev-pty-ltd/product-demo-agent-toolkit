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

## Highlights

Point the viewer at one thing: a red box around it, with the camera zooming toward it. Put
it on the step after which it should show:

```json
{ "click": { "role": "button", "name": "Save" }, "highlight": { "zoom": 0.5, "seconds": 2 } }
{ "press": "Enter", "highlight": { "box": [640, 120, 400, 300], "zoom": 0.3 } }
```

- Without a `box`, it highlights the step's own element (for a drag, where it was dropped).
  A step with no element (`press`, `type`, `visit`, `wait`) needs a `box`: x, y, width and
  height in pixels on that step's rehearsal still.
- `zoom` runs from 0 (none, the default) to 1 (the box fills the view). 0.3 to 0.6 reads
  best; near 1 on something small gets soft.
- `seconds` is how long it holds, 2 by default. The shoot holds still for it, so changing
  it means shooting again; changing the box or zoom only needs another cut.
- Use it for what the film is about: the result, or the one control that matters. One or
  two in a film; a highlight on every step points at nothing.

