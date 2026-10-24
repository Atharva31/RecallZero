"""Coordinator agent (PLAN.md section 9). Owner: Sarvesh.

Run from agents/:  .venv/bin/python -m coordinator.agent

Flow for a chat message such as "Start an investigation for contaminated ingredient PEANUT-009":
1. Claude extracts {root_lot, reason}; the lot is validated via GET /lots/:lotId.
2. Gateway as ORG-ACME: report_recall_signal -> authorize -> trace -> assign.
3. QuarantineRequest to each CONNECTED store's retailer agent (MANUAL stores use the store terminal).
4. Poll GET /recalls/:id/status: re-dispatch tasks the timeout reducer moved to RETRY_PENDING,
   and once settled, reply with a report drafted from GET /recalls/:id/report only.
"""

import itertools
from dataclasses import dataclass, field
from datetime import datetime, timezone
from uuid import uuid4

from uagents import Agent, Context, Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    EndSessionContent,
    TextContent,
    chat_protocol_spec,
)
from uagents_core.types import DeliveryStatus

from coordinator.llm import draft_report, extract_intent
from shared.config import AGENT_MAILBOX, GATEWAY_URL, POLL_INTERVAL_S
from shared.gateway import Gateway, GatewayError
from shared.messages import QuarantineRequest, QuarantineResult
from shared.peers import COORDINATOR_PORT, COORDINATOR_SEED, RETAILER_ADDRESSES, LocalFirstResolver, endpoint

ORG_ID = "ORG-ACME"

agent = Agent(
    name="recallzero-coordinator",
    seed=COORDINATOR_SEED,
    port=COORDINATOR_PORT,
    mailbox=AGENT_MAILBOX,
    endpoint=None if AGENT_MAILBOX else [endpoint(COORDINATOR_PORT)],
    resolve=LocalFirstResolver(),
)

chat = Protocol(spec=chat_protocol_spec)
gw = Gateway(ORG_ID)
_request_ids = itertools.count(1)


@dataclass
class ActiveRecall:
    recall_id: str
    reason: str
    chat_sender: str | None  # who to send progress and the final report to
    dispatched: dict[str, int] = field(default_factory=dict)  # task_id -> attempt number last dispatched
    requests: dict[str, str] = field(default_factory=dict)  # request_id -> task_id


active: dict[str, ActiveRecall] = {}


async def say(ctx: Context, to: str | None, text: str, end: bool = False):
    if not to:
        ctx.logger.info(f"[no chat recipient] {text}")
        return
    content = [TextContent(type="text", text=text)]
    if end:
        content.append(EndSessionContent(type="end-session"))
    await ctx.send(to, ChatMessage(timestamp=datetime.now(timezone.utc), msg_id=uuid4(), content=content))


async def dispatch(ctx: Context, rec: ActiveRecall, task: dict):
    """Send a QuarantineRequest for one CONNECTED task, once per lease attempt."""
    store_id = task["locationId"]
    address = RETAILER_ADDRESSES.get(store_id)
    if not address:
        ctx.logger.warning(f"{task['taskId']}: {store_id} is CONNECTED but has no retailer agent configured")
        return
    request_id = f"REQ-{next(_request_ids)}"
    rec.dispatched[task["taskId"]] = task["attempts"]
    rec.requests[request_id] = task["taskId"]
    msg = QuarantineRequest(
        request_id=request_id,
        recall_id=rec.recall_id,
        task_id=task["taskId"],
        store_id=store_id,
        lot_ids=task["lotIds"],
        reason=f"Authorized recall {rec.recall_id}: {rec.reason}",
    )
    status = await ctx.send(address, msg)
    delivered = status.status != DeliveryStatus.FAILED
    ctx.logger.info(
        f"QUARANTINE_REQUEST {request_id} -> {store_id} ({task['taskId']}, attempt {task['attempts']}): "
        f"{status.status.value}{'' if delivered else ' - ' + status.detail}"
    )


async def start_recall(ctx: Context, sender: str | None, root_lot: str, reason: str) -> str:
    """Runs signal -> authorize -> trace -> assign, dispatches agents, returns a chat summary."""
    recall = await gw.report_recall_signal(root_lot, reason)
    rid = recall["recallId"]
    await gw.authorize_recall(rid)
    traced = await gw.trace_recall(rid)
    assigned = await gw.assign_containment_tasks(rid)

    rec = ActiveRecall(recall_id=rid, reason=reason, chat_sender=sender)
    active[rid] = rec
    connected = [t for t in assigned["tasks"] if t["integrationLevel"] == "CONNECTED"]
    manual = [t for t in assigned["tasks"] if t["integrationLevel"] == "MANUAL"]
    for t in connected:
        await dispatch(ctx, rec, t)

    locs = traced["affectedLocations"]
    exceptions = [a for a in locs if a["status"] == "RECONCILIATION_EXCEPTION"]
    lines = [
        f"Recall {rid} authorized for {root_lot} ({reason}).",
        f"Trace: affected lots {', '.join(traced['affectedLots'])}; {len(locs)} affected locations.",
        f"Quarantine requests sent to agents at {', '.join(t['locationId'] for t in connected) or 'no connected stores'}.",
    ]
    if manual:
        lines.append(f"Manual confirmation needed at {', '.join(t['locationId'] for t in manual)} (store terminal).")
    if exceptions:
        lines.append(
            "Reconciliation exceptions: "
            + ", ".join(f"{a['locationId']} ({a['unaccountedUnits']} units unaccounted)" for a in exceptions)
            + "."
        )
    lines.append("I'll report back when every connected store is verified or escalated.")
    return "\n".join(lines)


@chat.on_message(ChatMessage)
async def on_chat(ctx: Context, sender: str, msg: ChatMessage):
    await ctx.send(sender, ChatAcknowledgement(timestamp=datetime.now(timezone.utc), acknowledged_msg_id=msg.msg_id))
    text = " ".join(c.text for c in msg.content if isinstance(c, TextContent)).strip()
    if not text:
        return
    ctx.logger.info(f"chat from {sender}: {text!r}")

    intent = await extract_intent(text)
    ctx.logger.info(f"intent: {intent}")
    if not intent.root_lot:
        await say(ctx, sender, "Which lot is contaminated? Give me the lot ID, e.g. \"PEANUT-009\".")
        return
    try:
        await gw.get_lot(intent.root_lot)
    except GatewayError as e:
        if e.code == "NOT_FOUND":
            await say(ctx, sender, f"I can't find lot {intent.root_lot} in the supply-chain records, so no recall was started.")
        else:
            await say(ctx, sender, f"Could not check lot {intent.root_lot}: {e}")
        return

    try:
        summary = await start_recall(ctx, sender, intent.root_lot, intent.reason)
    except GatewayError as e:
        ctx.logger.error(f"recall flow failed: {e}")
        await say(ctx, sender, f"Recall for {intent.root_lot} could not be completed: {e.message} ({e.code}).")
        return
    await say(ctx, sender, summary)


@chat.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    pass


@agent.on_message(QuarantineResult)
async def on_result(ctx: Context, sender: str, msg: QuarantineResult):
    ctx.logger.info(f"QUARANTINE_RESULT from {sender}: {msg}")
    rec = next((r for r in active.values() if msg.request_id in r.requests), None)
    if rec is None:
        return
    store = next((s for s, a in RETAILER_ADDRESSES.items() if a == sender), sender[:16])
    detail = f" ({msg.error})" if msg.error else ""
    await say(ctx, rec.chat_sender, f"{store}: {msg.status}, {msg.quarantined_units} units quarantined{detail}.")


@agent.on_interval(period=POLL_INTERVAL_S)
async def poll(ctx: Context):
    for rid, rec in list(active.items()):
        try:
            status = await gw.recall_status(rid)
        except GatewayError as e:
            ctx.logger.warning(f"status poll for {rid} failed: {e}")
            continue
        for t in status["tasks"]:
            # check_task_timeouts opened a new lease window: try the agent again.
            if (
                t["integrationLevel"] == "CONNECTED"
                and t["state"] == "RETRY_PENDING"
                and rec.dispatched.get(t["taskId"], 0) < t["attempts"]
            ):
                await dispatch(ctx, rec, t)
        if status["settled"]:
            del active[rid]
            facts = await gw.report_facts(rid)
            report = await draft_report(facts)
            ctx.logger.info(f"final report for {rid}:\n{report}")
            await say(ctx, rec.chat_sender, report, end=True)


@agent.on_event("startup")
async def startup(ctx: Context):
    ctx.logger.info(f"coordinator address: {agent.address}  (gateway {GATEWAY_URL}, mailbox={AGENT_MAILBOX})")
    ctx.logger.info(f"retailer agents: {RETAILER_ADDRESSES}")
    try:
        h = await gw.health()
        ctx.logger.info(f"gateway ok ({h.get('spacetimedb')})")
    except GatewayError as e:
        ctx.logger.warning(f"gateway not reachable yet: {e}")


agent.include(chat, publish_manifest=True)

if __name__ == "__main__":
    agent.run()
