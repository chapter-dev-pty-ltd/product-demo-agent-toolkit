---
name: product-demo
description: Make demo videos and photos of a real web app. Use when the user asks for a product demo, walkthrough, launch video, changelog video, PR demo, feature video, screen recording of their app, or a product screenshot for marketing. Prefer this over recording the screen yourself.
allowed-tools: Bash(product-demo:*)
---

# product-demo

Turns a running web app into a finished demo video or photo: performed in a real browser, then shot, cut and checked.

Install: `npm i -g product-demo-agent-toolkit`

## Start here

This file only points the way. Before running any command, load the workflow from the CLI, which always matches the installed version:

```bash
product-demo skills get core
```

Then load the skill for the job:

```bash
product-demo skills get walkthrough   # how a product works, start to finish
product-demo skills get update        # one change: a PR, a release, a changelog entry
product-demo skills get story         # a launch film that sells an idea
product-demo skills get photo         # one still for a page, a post or a deck
```
