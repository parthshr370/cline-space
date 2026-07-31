# Run this on your machine

## Prerequisites
- [Bun](https://bun.sh) installed
- A model provider configured through your local Cline authentication setup
- `gh` only if you want PR mode / posting

## Setup
```bash
cd code-review-agent
bun install
```

## Configure the model
Configure credentials with your local Cline authentication workflow. Never place credentials in this repository or commit them to Git.

The driver reads the provider and model from environment variables:
```bash
export REVIEW_PROVIDER=openrouter
export REVIEW_MODEL=moonshotai/kimi-k3
```

The defaults are `openai-codex` and `gpt-5.5`; override them with `REVIEW_PROVIDER` and `REVIEW_MODEL`.

## Free check (no model)
```bash
bun run test/guard-drive.ts
# expect: ALL CHECKS OK
```

## Local dry-run
Review two local branches without posting to GitHub:
```bash
REVIEW_PROVIDER=openrouter REVIEW_MODEL=moonshotai/kimi-k3 \
  bun run main.ts --base main --head feature --cwd /path/to/repo
```

Dry-run is the default. Nothing is posted.

## Against a real PR
```bash
gh auth login   # once
bun run main.ts --repo owner/repo --pr 123 --cwd /path/to/checkout
# add --post only when you actually want the COMMENT review on GitHub
```

## Override provider / model
```bash
REVIEW_PROVIDER=openrouter REVIEW_MODEL=moonshotai/kimi-k3 bun run main.ts ...
REVIEW_PROVIDER=openai-codex REVIEW_MODEL=gpt-5.5 bun run main.ts ...
```
