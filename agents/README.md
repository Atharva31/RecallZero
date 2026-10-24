# Agents (Sarvesh)

Coordinator + retailer uAgents. They talk to each other directly on localhost (addresses are
derived from the seeds in `shared/peers.py`) and to the database only through the gateway.

```bash
(cd ../gateway && npm run dev)          # mock gateway on :4000
npm run dev:coordinator                 # :8001
npm run dev:store-a                     # :8002
npm run dev:store-b                     # :8003  (leave it off to demo the timeout -> ESCALATED path)
npm run chat -- "Start an investigation for contaminated ingredient PEANUT-009 and contain it."
```

`npm run chat` is a local stand-in for ASI:One: it sends one chat message to the coordinator and
prints every reply until the final report. With Store B off, the chat shows the request was not
delivered, each lease timeout and retry, then the escalation (~60 s), and the report lists STORE-B
as INVENTORY_UNKNOWN. Manual confirmations at the store terminal are announced as they commit.

- `coordinator/llm.py`: Claude extracts `{root_lot, reason}` and drafts the report from
  `GET /recalls/:id/report` facts only. Answers are cached in `claude_cache.json`, so a rehearsed
  demo never waits on the API. Without `ANTHROPIC_API_KEY`, or when Claude fails, it falls back to
  a regex parser and a fixed report template.
- `retailer/agent.py`: claim -> inventory check -> quarantine, then replies with the status read
  back from the gateway.
- `AGENT_MAILBOX=true` connects both agents to Agentverse, which ASI:One needs. The coordinator
  publishes its profile from `coordinator/agentverse_readme.md` when the mailbox connects.

## Demo cache (PLAN.md section 13)

The intent cache key ignores case, spacing and end punctuation. The report key is the report facts,
so cache the report from a rehearsal that ends in the same state as the stage demo:

1. Set `ANTHROPIC_API_KEY` in the repo-root `.env`, then run `npm --prefix ../scripts run reset`.
2. Run the demo through `npm run chat` (or ASI:One) with Store B off, and confirm Stores C, D and E
   at the store terminal during the Store B wait.
3. Run `npm run warm-cache`. It caches the demo phrasings and the report of every settled recall,
   prints them, and exits non-zero if anything is missing. Commit `claude_cache.json`.

## ASI:One

1. Set `AGENTVERSE_API_KEY` and `AGENT_MAILBOX=true` in `.env`, then start the coordinator and the Store A agent.
2. Open the "Agent inspector" link from the coordinator log, click Connect, and choose Mailbox.
3. In ASI:One, chat with the coordinator by its address (logged at startup): "Start an investigation
   for contaminated ingredient PEANUT-009 and contain it."
