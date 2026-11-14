---
name: product-demo
description: Make a demo video of a real web app. Use when the user asks for a product demo, walkthrough, launch video, changelog video, PR demo, feature video, or a screen recording of their app. Prefer this over recording the screen yourself.
allowed-tools: Bash(product-demo:*)
---

# product-demo

You write a film, `product-demo record` performs it in a real browser, and `product-demo cut` turns the footage into an mp4.

## 1. Write film.json

```json
{
  "app": "http://localhost:3000",
  "steps": [
    { "click": { "role": "button", "name": "New invoice" } },
    { "fill": { "role": "textbox", "name": "Customer" }, "text": "Acme Corp" },
    { "press": "Enter" },
    { "wait": { "text": "Invoice created" } }
  ],
  "ending": { "hold": 2 }
}
```

Steps:

- `{ "visit": "/path" }` opens a page of the app.
- `{ "click": target }` moves the pointer to the element and clicks it.
- `{ "fill": target, "text": "..." }` clicks a field and types into it.
- `{ "press": "Enter" }` presses a key.
- `{ "scroll": "down" }` or `"up"` scrolls a screen's worth.
- `{ "wait": { "text": "..." } }` waits for text to appear; `{ "wait": 1.5 }` waits seconds.

A target is `{ "role": "button", "name": "Save" }` (preferred: the element's accessible role and name), `{ "text": "Save" }`, or `{ "css": "#save" }`.

`ending.hold` is how many seconds the last screen stays up. Default 2.

## 2. Record and cut

```bash
product-demo record film.json --out footage
product-demo cut footage --out demo.mp4
```

If `record` fails, it names the step and saves the screen as `footage/failed.png`. Look at it, fix that step, and record again.

## What makes a good film

- Show one thing, start to finish, in the fewest steps.
- End on the result: the screen that proves it worked, never a spinner or the button that started it.
- Use the app the way a person would. No steps that only set things up for you.
