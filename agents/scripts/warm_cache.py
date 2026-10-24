"""Fill claude_cache.json for the demo, so no demo beat waits on the Claude API (PLAN.md section 13).

Run from agents/ with ANTHROPIC_API_KEY set and the gateway running:
    .venv/bin/python -m scripts.warm_cache

1. Extracts the intent for each demo phrasing below (case, spacing and end punctuation don't matter).
2. Drafts the report for every settled recall the gateway knows about. The report is keyed by its
   facts, so rehearse first: run the demo through `npm run chat` (or ASI:One) and confirm Stores C, D
   and E during the Store B wait, exactly as on stage. Then run this script, and commit the cache.

Prints what is cached and exits non-zero if anything is still missing.
"""

import asyncio
import sys

from coordinator.llm import cached, draft_report, extract_intent, intent_key, report_key
from shared.config import ANTHROPIC_API_KEY, CLAUDE_CACHE_PATH
from shared.gateway import Gateway, GatewayError

DEMO_PHRASES = [
    "Start an investigation for contaminated ingredient PEANUT-009 and contain it.",
    "Start an investigation for contaminated ingredient PEANUT-009 and contain it",
    "Start a recall for PEANUT-009, Salmonella contamination.",
    "Contain contaminated ingredient lot PEANUT-009.",
]


async def main() -> int:
    if not ANTHROPIC_API_KEY:
        print("ANTHROPIC_API_KEY is not set (repo-root .env); nothing can be cached.")
        return 1
    missing = 0

    for text in DEMO_PHRASES:
        intent = await extract_intent(text)
        ok = cached(intent_key(text))
        missing += not ok
        print(f"{'cached ' if ok else 'MISSING'}  intent  {text!r} -> {intent.root_lot}, {intent.reason!r}")

    gw = Gateway("ORG-ACME")
    try:
        recalls = await gw.list_recalls()
        for r in recalls:
            status = await gw.recall_status(r["recallId"])
            if not status["settled"]:
                print(f"skipped  report  {r['recallId']} ({r['status']}): not settled yet")
                continue
            facts = await gw.report_facts(r["recallId"])
            report = await draft_report(facts)
            ok = cached(report_key(facts))
            missing += not ok
            print(f"{'cached ' if ok else 'MISSING'}  report  {r['recallId']} ({r['reason']}):\n{report}\n")
        if not recalls:
            print("no recalls on the gateway: rehearse the demo first to cache its report")
    except GatewayError as e:
        print(f"gateway: {e}")
        missing += 1
    finally:
        await gw.aclose()

    print(f"cache: {CLAUDE_CACHE_PATH}")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
