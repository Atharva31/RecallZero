"""Retailer agent (PLAN.md section 9). Owner: Sarvesh. One codebase, one instance per store.

Run from agents/:  STORE_ID=STORE-A .venv/bin/python -m retailer.agent
                   STORE_ID=STORE-B .venv/bin/python -m retailer.agent

On QuarantineRequest: POST /tasks/:id/claim -> GET inventory -> POST /tasks/:id/quarantine
(as ORG-<STORE_ID>), then reply with the committed result read back from the gateway,
never the agent's own claim.
"""

import os

from uagents import Agent, Context

from shared.config import AGENT_MAILBOX, GATEWAY_URL
from shared.gateway import Gateway, GatewayError
from shared.messages import QuarantineRequest, QuarantineResult
from shared.peers import COORDINATOR_ADDRESS, LocalFirstResolver, endpoint, retailer_port, retailer_seed

STORE_ID = os.getenv("STORE_ID", "STORE-A")
ORG_ID = f"ORG-{STORE_ID}"
PORT = retailer_port(STORE_ID)

agent = Agent(
    name=f"recallzero-retailer-{STORE_ID.lower()}",
    seed=retailer_seed(STORE_ID),
    port=PORT,
    mailbox=AGENT_MAILBOX,
    endpoint=None if AGENT_MAILBOX else [endpoint(PORT)],
    resolve=LocalFirstResolver(),
)

gw = Gateway(ORG_ID)


async def committed_location(recall_id: str) -> tuple[str, int]:
    """Read this store's affected-location status and quarantined units back from the database."""
    status = await gw.recall_status(recall_id)
    loc = next(a for a in status["affectedLocations"] if a["locationId"] == STORE_ID)
    return loc["status"], loc["quarantinedUnits"]


async def handle(ctx: Context, msg: QuarantineRequest) -> QuarantineResult:
    def result(status: str, units: int, error: str | None = None):
        return QuarantineResult(request_id=msg.request_id, task_id=msg.task_id, status=status, quarantined_units=units, error=error)

    if msg.store_id != STORE_ID:
        return result("ACTION_FAILED", 0, f"request for {msg.store_id} sent to {STORE_ID} agent")

    try:
        try:
            task = await gw.claim_task(msg.task_id)
            ctx.logger.info(f"claimed {msg.task_id} (attempt {task['attempts']}, lease until {task['leaseExpiresAt']})")
        except GatewayError as e:
            if e.code != "INVALID_STATE":  # INVALID_STATE: already verified/escalated, read back below
                raise
            ctx.logger.info(f"{msg.task_id} not claimable: {e.message}")
            task = await gw.get_task(msg.task_id)
            if task["state"] != "VERIFIED":
                status, units = await committed_location(msg.recall_id)
                return result(status, units, e.message)

        if task["state"] != "VERIFIED":
            stock = {b["lotId"]: b for b in await gw.inventory(STORE_ID)}
            for lot in msg.lot_ids:
                b = stock.get(lot)
                ctx.logger.info(
                    f"stock {lot}: " + (f"{b['available']} available, {b['quarantined']} quarantined" if b else "none on record")
                )
            q = await gw.quarantine_lot(msg.task_id)  # idempotent in the reducer
            ctx.logger.info(f"quarantine committed for {msg.task_id}")
            return result(q["affectedLocation"]["status"], q["quarantinedUnits"])

        status, units = await committed_location(msg.recall_id)
        return result(status, units)
    except GatewayError as e:
        ctx.logger.error(f"{msg.task_id} failed: {e}")
        try:
            status, units = await committed_location(msg.recall_id)
        except (GatewayError, StopIteration):
            status, units = "ACTION_FAILED", 0
        return result(status, units, f"{e.code}: {e.message}")


@agent.on_message(QuarantineRequest, replies=QuarantineResult)
async def on_request(ctx: Context, sender: str, msg: QuarantineRequest):
    ctx.logger.info(f"QUARANTINE_REQUEST from {sender}: {msg}")
    res = await handle(ctx, msg)
    ctx.logger.info(f"QUARANTINE_RESULT {res.request_id}: {res.status}, {res.quarantined_units} units")
    await ctx.send(sender, res)


@agent.on_event("startup")
async def startup(ctx: Context):
    ctx.logger.info(f"retailer {STORE_ID} ({ORG_ID}) address: {agent.address}  (gateway {GATEWAY_URL})")
    ctx.logger.info(f"coordinator: {COORDINATOR_ADDRESS}")


if __name__ == "__main__":
    agent.run()
