"""Coordinator agent (PLAN.md section 9). Owner: Sarvesh.

Run from agents/:  .venv/bin/python -m coordinator.agent

TODO(Sarvesh):
- Claude extracts {root_lot, reason} from chat text; validate via GET /lots/:lotId.
- Gateway (X-Org-Id: ORG-ACME): signal -> authorize -> trace -> assign.
- Send QuarantineRequest to each CONNECTED store's retailer agent.
- Poll GET /recalls/:id/status until settled; draft report from GET /recalls/:id/report only.
"""

import os
from datetime import datetime, timezone
from uuid import uuid4

from uagents import Agent, Context, Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    TextContent,
    chat_protocol_spec,
)

from shared.config import AGENT_MAILBOX, GATEWAY_URL
from shared.messages import QuarantineResult

PORT = int(os.getenv("COORDINATOR_PORT", "8001"))

agent = Agent(
    name="recallzero-coordinator",
    seed=os.getenv("COORDINATOR_SEED", "recallzero-coordinator-dev-seed"),
    port=PORT,
    mailbox=AGENT_MAILBOX,
    endpoint=None if AGENT_MAILBOX else [f"http://127.0.0.1:{PORT}/submit"],
)

chat = Protocol(spec=chat_protocol_spec)


@chat.on_message(ChatMessage)
async def on_chat(ctx: Context, sender: str, msg: ChatMessage):
    await ctx.send(sender, ChatAcknowledgement(timestamp=datetime.now(timezone.utc), acknowledged_msg_id=msg.msg_id))
    text = " ".join(c.text for c in msg.content if isinstance(c, TextContent))
    ctx.logger.info(f"chat from {sender}: {text!r}")
    reply = f"RecallZero coordinator received: {text!r}. (Recall flow not wired yet; gateway at {GATEWAY_URL}.)"
    await ctx.send(
        sender,
        ChatMessage(timestamp=datetime.now(timezone.utc), msg_id=uuid4(), content=[TextContent(type="text", text=reply)]),
    )


@chat.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    pass


@agent.on_message(QuarantineResult)
async def on_result(ctx: Context, sender: str, msg: QuarantineResult):
    ctx.logger.info(f"QUARANTINE_RESULT from {sender}: {msg}")


@agent.on_event("startup")
async def startup(ctx: Context):
    ctx.logger.info(f"coordinator address: {agent.address}  (gateway {GATEWAY_URL}, mailbox={AGENT_MAILBOX})")


agent.include(chat, publish_manifest=True)

if __name__ == "__main__":
    agent.run()
