"""Retailer agent (PLAN.md section 9). Owner: Sarvesh. One codebase, one instance per store.

Run from agents/:  STORE_ID=STORE-A .venv/bin/python -m retailer.agent
                   STORE_ID=STORE-B .venv/bin/python -m retailer.agent

TODO(Sarvesh): on QuarantineRequest -> POST /tasks/:id/claim -> GET inventory ->
POST /tasks/:id/quarantine (X-Org-Id: ORG-<STORE_ID>) -> reply with the committed
result read back from the gateway, never the agent's own claim.
"""

import os

from uagents import Agent, Context

from shared.config import AGENT_MAILBOX, GATEWAY_URL
from shared.messages import QuarantineRequest, QuarantineResult

STORE_ID = os.getenv("STORE_ID", "STORE-A")
ORG_ID = f"ORG-{STORE_ID}"
PORT = int(os.getenv("RETAILER_PORT", {"STORE-A": "8002", "STORE-B": "8003"}.get(STORE_ID, "8004")))

agent = Agent(
    name=f"recallzero-retailer-{STORE_ID.lower()}",
    seed=os.getenv("RETAILER_SEED", f"recallzero-retailer-{STORE_ID}-dev-seed"),
    port=PORT,
    mailbox=AGENT_MAILBOX,
    endpoint=None if AGENT_MAILBOX else [f"http://127.0.0.1:{PORT}/submit"],
)


@agent.on_message(QuarantineRequest, replies=QuarantineResult)
async def on_request(ctx: Context, sender: str, msg: QuarantineRequest):
    ctx.logger.info(f"QUARANTINE_REQUEST from {sender}: {msg}")
    await ctx.send(
        sender,
        QuarantineResult(
            request_id=msg.request_id,
            task_id=msg.task_id,
            status="AWAITING_ACKNOWLEDGMENT",
            quarantined_units=0,
            error="not implemented yet",
        ),
    )


@agent.on_event("startup")
async def startup(ctx: Context):
    ctx.logger.info(f"retailer {STORE_ID} ({ORG_ID}) address: {agent.address}  (gateway {GATEWAY_URL})")


if __name__ == "__main__":
    agent.run()
