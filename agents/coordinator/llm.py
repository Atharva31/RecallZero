"""Claude calls for the coordinator (PLAN.md section 9). Claude only parses and explains;
every state change goes through the gateway's reducers.

- extract_intent(text)  -> Intent(root_lot, reason)    from the user's chat message
- draft_report(facts)   -> str                         prose from GET /recalls/:id/report only

Both are cached on disk (CLAUDE_CACHE_PATH) keyed by their input, so a rehearsed demo
replays without touching the API. Both fall back to deterministic code when Claude is
unavailable (no key, timeout, refusal), so the flow never stalls on the LLM.
"""

import asyncio
import hashlib
import json
import logging
import re
from typing import Optional

import anthropic
from pydantic import BaseModel

from shared.config import ANTHROPIC_API_KEY, CLAUDE_CACHE_PATH, CLAUDE_MODEL, CLAUDE_TIMEOUT_S

log = logging.getLogger("coordinator.llm")

_client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY, timeout=CLAUDE_TIMEOUT_S, max_retries=1) if ANTHROPIC_API_KEY else None
# Refusal fallback routing (server side); see the claude-api reference.
_BETAS = ["server-side-fallback-2026-07-01"]


class Intent(BaseModel):
    root_lot: Optional[str]  # e.g. "PEANUT-009"; null if the message names no lot
    reason: str  # e.g. "Salmonella contamination"


# ---------- cache ----------

def _key(kind: str, payload: object) -> str:
    return kind + ":" + hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]


def _cache_read() -> dict:
    try:
        return json.loads(CLAUDE_CACHE_PATH.read_text())
    except (FileNotFoundError, ValueError):
        return {}


def _cache_get(key: str):
    return _cache_read().get(key)


def _cache_put(key: str, value) -> None:
    data = _cache_read()
    data[key] = value
    CLAUDE_CACHE_PATH.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


# ---------- intent extraction ----------

_INTENT_SYSTEM = """You extract recall requests for RecallZero, a food-recall execution system.
From the user's message, return the contaminated lot ID exactly as written (uppercase, e.g. PEANUT-009)
and a short reason (e.g. "Salmonella contamination"). If no lot ID is present, return root_lot as null.
If no reason is given, use "Contamination reported"."""

_LOT_RE = re.compile(r"\b([A-Za-z]+-\d{2,})\b")
_HAZARDS = ["salmonella", "listeria", "e. coli", "e.coli", "allergen", "aflatoxin", "metal", "glass", "mold", "botulism"]


def parse_intent_offline(text: str) -> Intent:
    m = _LOT_RE.search(text)
    hazard = next((h for h in _HAZARDS if h in text.lower()), None)
    reason = f"{hazard.capitalize()} contamination" if hazard else "Contamination reported"
    return Intent(root_lot=m.group(1).upper() if m else None, reason=reason)


async def extract_intent(text: str) -> Intent:
    key = _key("intent", text.strip())
    if (hit := _cache_get(key)) is not None:
        return Intent(**hit)
    if _client is None:
        return parse_intent_offline(text)
    try:
        res = await _client.beta.messages.parse(
            model=CLAUDE_MODEL,
            max_tokens=1024,
            system=_INTENT_SYSTEM,
            messages=[{"role": "user", "content": text}],
            output_format=Intent,
            output_config={"effort": "low"},
            betas=_BETAS,
            fallbacks="default",
        )
        if res.stop_reason == "refusal" or res.parsed_output is None:
            raise ValueError(f"no parsed output (stop_reason={res.stop_reason})")
        intent = res.parsed_output
        if intent.root_lot:
            intent.root_lot = intent.root_lot.upper()
        _cache_put(key, intent.model_dump())
        return intent
    except (anthropic.APIError, ValueError, asyncio.TimeoutError) as e:
        log.warning(f"Claude intent extraction failed, using offline parser: {e}")
        return parse_intent_offline(text)


# ---------- report drafting ----------

_REPORT_SYSTEM = """You write the final recall status report for RecallZero.
Use ONLY the JSON facts provided; they are committed database records. Do not invent stores, units or events.
Rules:
- Only locations listed under "verified" are contained. Never describe any other location as contained or safe.
- Locations under "unknown" or "escalated" are unverified: say plainly that their inventory status is not known.
- Report sold-before-recall, lost-in-transit and unaccounted units separately; they are not contained.
- State location coverage and unit coverage as percentages.
Format: plain text for a chat reply, a one-line headline, then short sections with bullet points. Under 250 words."""


def _pct(x: float) -> str:
    return f"{round(x * 100)}%"


def report_offline(f: dict) -> str:
    c = f["coverage"]
    lines = [
        f"Recall {f['recallId']}: {f['rootLotId']} ({f['reason']}). Affected lots: {', '.join(f['affectedLots']) or 'none'}.",
        f"Location coverage {_pct(c['locationCoverage'])} ({c['verifiedLocations']}/{c['affectedLocations']} verified); "
        f"unit coverage {_pct(c['unitCoverage'])} ({c['quarantinedUnits']}/{c['knownUnsoldUnits']} known unsold units quarantined).",
    ]

    def section(title: str, rows: list[str]):
        if rows:
            lines.append(f"\n{title}:")
            lines.extend(f"- {r}" for r in rows)

    section("Verified contained", [f"{v['locationId']}: {v['quarantinedUnits']} units quarantined" for v in f["verified"]])
    section("NOT verified (status unknown)", [f"{u['locationId']}: {u['status']}" for u in f["unknown"]])
    section("Escalated", [f"{e['locationId']}: task {e['taskId']} after {e['attempts']} attempts" for e in f["escalated"]])
    section("Sold before recall", [f"{s['locationId']}: {s['units']} units" for s in f["soldBeforeRecall"]])
    section("Lost in transit", [f"{s['locationId']}: {s['units']} units" for s in f["lostInTransit"]])
    section("Unaccounted (reconciliation exception)", [f"{s['locationId']}: {s['units']} units" for s in f["unaccounted"]])
    return "\n".join(lines)


async def draft_report(facts: dict) -> str:
    stable = {k: v for k, v in facts.items() if k != "generatedAt"}
    key = _key("report", stable)
    if (hit := _cache_get(key)) is not None:
        return hit
    if _client is None:
        return report_offline(facts)
    try:
        res = await _client.beta.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=4096,
            system=_REPORT_SYSTEM,
            messages=[{"role": "user", "content": json.dumps(stable, indent=2)}],
            output_config={"effort": "low"},
            betas=_BETAS,
            fallbacks="default",
        )
        text = "".join(b.text for b in res.content if b.type == "text").strip()
        if res.stop_reason == "refusal" or not text:
            raise ValueError(f"empty report (stop_reason={res.stop_reason})")
        _cache_put(key, text)
        return text
    except (anthropic.APIError, ValueError, asyncio.TimeoutError) as e:
        log.warning(f"Claude report drafting failed, using template: {e}")
        return report_offline(facts)
