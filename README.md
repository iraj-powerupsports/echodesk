# EchoDesk

Say what you're doing out loud ("deploying the API, I'll check back in 4 minutes"). EchoDesk transcribes it in
the browser, uses Claude to turn it into tasks with follow-up times, and pings you when it's time to come back.

Stack: React + Vite frontend and a Hono API, both on one Cloudflare Worker, with D1 (SQLite) for storage and
the Claude API for task extraction. Speech-to-text is the browser's Web Speech API, so use Chrome or Edge.
Design: [`docs/superpowers/specs/2026-10-25-echodesk-v1-design.md`](docs/superpowers/specs/2026-10-25-echodesk-v1-design.md).

## Run locally

```sh
npm install
npm run db:local                      # create tables in the local D1
cat > .dev.vars <<'EOF'
APP_TOKEN=pick-a-long-random-string
ANTHROPIC_API_KEY=sk-ant-...
EOF
npm run dev                           # http://localhost:5173
npm test
```

## Deploy (Cloudflare free tier)

```sh
npx wrangler login
npx wrangler d1 create echodesk       # paste the printed database_id into wrangler.jsonc
npm run db:remote
npx wrangler secret put APP_TOKEN
npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy                        # prints https://echodesk.<you>.workers.dev
```

Open the URL, enter your `APP_TOKEN`, click **Start listening**, and allow the microphone and notifications.

## Notes

- The model is set by `MODEL` in `wrangler.jsonc` (default `claude-haiku-5-5`, the cheapest option).
- Keep the tab open: alerts come from the page. Chrome slows timers in background tabs, so an alert can be up
  to about a minute late.
- Browser speech recognition sends audio to the browser vendor (Google for Chrome). Every transcript is
  stored in D1 with Claude's raw reply, which you can see on the **Transcript log** page.
