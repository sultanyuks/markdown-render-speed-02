# markdown-render-speed-02
[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/sultanyuks/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/sultanyuks/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
A dependency-free Markdown renderer whose output matches marked 18.1.3 with default options (GFM on, breaks off) byte for byte, built to render faster: block structure is recognised with a first-match dispatch over anchored grammar patterns, list and quote continuations reuse clamped indent probes, inline text is scanned in a single pass with a masked twin string for emphasis delimiter matching, link reference definitions are collected during the block pass so forward references resolve, and the token tree is rendered straight to a string with no wasted intermediate copies.
## Run it
```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```
---
<sub>Entered on [make.fun](https://make.fun/?ref=tv86zvxh&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
