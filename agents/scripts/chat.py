"""Local stand-in for ASI:One: sends one chat message to the coordinator and prints every reply.

Run from agents/ (coordinator, retailers and gateway already running):
    .venv/bin/python -m scripts.chat "Start an investigation for contaminated ingredient PEANUT-009 and contain it."

Exits after the coordinator ends the session (final report), or after CHAT_TIMEOUT_S seconds.
"""

import os
import sys
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

from shared.peers import CHAT_CLIENT_PORT, CHAT_CLIENT_SEED, COORDINATOR_ADDRESS, LocalFirstResolver, endpoint

TEXT = " ".join(sys.argv[1:]) or "Start an investigation for contaminated ingredient PEANUT-009 and contain it."
TIMEOUT_S = float(os.getenv("CHAT_TIMEOUT_S", "180"))

client = Agent(
    name="recallzero-chat-client",
    seed=CHAT_CLIENT_SEED,
    port=CHAT_CLIENT_PORT,
    endpoint=[endpoint(CHAT_CLIENT_PORT)],
    resolve=LocalFirstResolver(),
)
chat = Protocol(spec=chat_protocol_spec)
started = datetime.now(timezone.utc)


@client.on_event("startup")
async def send(ctx: Context):
    print(f"> {TEXT}\n", flush=True)
    await ctx.send(
        COORDINATOR_ADDRESS,
        ChatMessage(timestamp=datetime.now(timezone.utc), msg_id=uuid4(), content=[TextContent(type="text", text=TEXT)]),
    )


@chat.on_message(ChatMessage)
async def on_reply(ctx: Context, sender: str, msg: ChatMessage):
    await ctx.send(sender, ChatAcknowledgement(timestamp=datetime.now(timezone.utc), acknowledged_msg_id=msg.msg_id))
    for c in msg.content:
        if isinstance(c, TextContent):
            print(f"[{(datetime.now(timezone.utc) - started).seconds:>3}s] coordinator:\n{c.text}\n", flush=True)
    if any(isinstance(c, EndSessionContent) for c in msg.content):
        os._exit(0)


@chat.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    pass


@client.on_interval(period=5)
async def deadline(ctx: Context):
    if (datetime.now(timezone.utc) - started).total_seconds() > TIMEOUT_S:
        print("timed out waiting for the final report", flush=True)
        os._exit(1)


client.include(chat)

if __name__ == "__main__":
    client.run()
