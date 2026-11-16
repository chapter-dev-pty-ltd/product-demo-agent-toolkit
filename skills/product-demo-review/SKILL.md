---
name: product-demo-review
description: Check a demo video made with product-demo before giving it to the user. Use after `product-demo cut`, or when the user asks whether a demo video is right.
allowed-tools: Bash(product-demo:*)
---

# product-demo-review

You can't watch a video, so `review` lays frames from across it out in one image you can look at.

```bash
product-demo review            # the latest video; or: product-demo review <footage folder>, or the .mp4 cut --out wrote
```

It prints the image's path (`review.jpg`, beside the video). Open it and read it left to right, top to bottom: 24 frames, evenly spaced from the first to the last.

Setting `"review": true` in `.product-demo/config.json` makes `cut` produce it every time.

## What to check

- **It's what was asked for.** The steps in the frames are the flow the user described, in that order, on the right things.
- **It ends on the result.** The last frames show the screen that proves it worked: not a spinner, an error, or the button that started it.
- **Nothing is stuck.** No long run of identical frames on a loading screen.
- **Nothing is in the way.** No error message, cookie banner or dialog covering what matters, and the pointer isn't sitting on the result.

## When something is wrong

Say what you saw, frame by frame. If the film can fix it (a wrong step, a missing wait for the result), fix `film.json`, rehearse, shoot and cut again, then review again. If it can't (the app showed an error, or the toolkit can't do what's needed), tell the user rather than handing over the video.
