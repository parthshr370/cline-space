# cline-space

`cline-space` is an open-source collection of Cline SDK example projects by parthshr370. Each project is kept self-contained so it can be copied, studied, and run independently.

The first project, [`code-review-agent/`](code-review-agent/), is a pull-request review agent built on `@cline/sdk`. It uses a two-pass review-and-judge loop, a read-only guard, and a review journal. See [`code-review-agent/README.md`](code-review-agent/README.md) for setup and usage.

[`jev-playground/`](jev-playground/) is a Cline plugin that turns a vague prompt into a local page for asking Jev (TypeSafe's System One) yes/no, pick-one, and scale questions. Cline sets up the details and questions, then anyone can edit them and press Ask Jev. See [`jev-playground/README.md`](jev-playground/README.md) for install and usage.

[`jev-guard/`](jev-guard/) is a Cline plugin that screens everything the agent reads (web pages, files, command output, MCP results) with checks you write in plain words and test on a local page. A Cline hook runs it on every tool result, and flagged text is noted, flagged to the agent, hidden, or turned into a question for you. See [`jev-guard/README.md`](jev-guard/README.md) for install and usage.
