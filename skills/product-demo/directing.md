# Directing the cut

What the video looks like, as opposed to what happens in the app. These are set in
`film.json` and drawn by `product-demo cut`, so changing one never means shooting again:
edit the film, run `cut`, and the new video is ready in seconds.

## The cursor

The cut draws the cursor along the path the pointer took when the film was shot: a rounded
arrow, with a ripple from its tip on every click. It comes in two colours:

- `pink`, the default.
- `lime`.

Set it for one film at its top level, `"cursor": "lime"`, or for every film in
`.product-demo/config.json`. Choose the one that stands out against the app: pink on most
apps, lime when the app is pink, red or warm-coloured, where pink gets lost. Keep one colour
for a whole film, and the same one across a set of films made together.
