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
prints every reply until the final report. With Store B off, the report shows STORE-B as
INVENTORY_UNKNOWN / escalated after 3 lease windows (~60 s).

- `coordinator/llm.py`: Claude extracts `{root_lot, reason}` and drafts the report from
  `GET /recalls/:id/report` facts only. Answers are cached in `claude_cache.json`, so a rehearsed
  demo never waits on the API. Without `ANTHROPIC_API_KEY`, or when Claude fails, it falls back to
  a regex parser and a fixed report template.
- `retailer/agent.py`: claim -> inventory check -> quarantine, then replies with the status read
  back from the gateway.
- `AGENT_MAILBOX=true` connects both agents to Agentverse, which ASI:One needs.
