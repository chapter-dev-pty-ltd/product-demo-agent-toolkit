---
name: core
description: The loop for every demo: plan, record, cut, check. Start here.
---

# Making a demo

Every demo goes through the same four steps. Don't skip one.

## 1. Plan

Write the plan before touching the browser:

- **Purpose**: walkthrough, update, story or photo. Load that skill too.
- **Steps**: what happens on screen, one action each.
- **The ending**: the screen that proves the feature worked. A demo ends on the result, never on a spinner, a toast or the button that started it.

## 2. Record

`product-demo record` performs the plan in a real browser and keeps the take and its event log. The app should look lived in: real-looking records, no "Test", no empty lists.

## 3. Cut

`product-demo cut` turns the take into the finished file under a Look. Camera, cursor, highlights and timing come from the event log, so changing the cut never means recording again.

## 4. Check

`product-demo check` judges the take against the quality rules. A take that fails is not done. Fix the plan or the data and record again.

## When the user reacts

Record their verdict with `product-demo feedback <take> --good|--bad "why"`. That is how the toolkit learns.
