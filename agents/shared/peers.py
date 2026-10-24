"""Local addressing for the RecallZero agents.

Agent addresses are derived from their seeds, so the coordinator knows each retailer's
address (and the retailers know the coordinator's) without a registry lookup.
Agent-to-agent messages are routed straight to the local HTTP endpoints; anything else
(e.g. an ASI:One user) falls back to the global Almanac resolver.
"""

import os

from uagents.resolver import GlobalResolver, Resolver, RulesBasedResolver
from uagents_core.identity import Identity

HOST = os.getenv("AGENT_HOST", "127.0.0.1")

COORDINATOR_PORT = int(os.getenv("COORDINATOR_PORT", "8001"))
COORDINATOR_SEED = os.getenv("COORDINATOR_SEED", "recallzero-coordinator-dev-seed")

# Local stand-in for ASI:One (scripts/chat.py), so chat replies route locally too.
CHAT_CLIENT_PORT = int(os.getenv("CHAT_CLIENT_PORT", "8009"))
CHAT_CLIENT_SEED = os.getenv("CHAT_CLIENT_SEED", "recallzero-chat-client-dev-seed")

# CONNECTED stores that run a retailer agent (PLAN.md section 6).
RETAILER_PORTS = {"STORE-A": 8002, "STORE-B": 8003}


def retailer_port(store_id: str) -> int:
    return int(os.getenv("RETAILER_PORT", RETAILER_PORTS.get(store_id, 8004)))


def retailer_seed(store_id: str) -> str:
    return os.getenv(f"RETAILER_SEED_{store_id.replace('-', '_')}", f"recallzero-retailer-{store_id}-dev-seed")


def address_for_seed(seed: str) -> str:
    return Identity.from_seed(seed, 0).address


def endpoint(port: int) -> str:
    return f"http://{HOST}:{port}/submit"


COORDINATOR_ADDRESS = address_for_seed(COORDINATOR_SEED)
CHAT_CLIENT_ADDRESS = address_for_seed(CHAT_CLIENT_SEED)
RETAILER_ADDRESSES = {store: address_for_seed(retailer_seed(store)) for store in RETAILER_PORTS}


class LocalFirstResolver(Resolver):
    """Known RecallZero agents resolve to their local endpoints; everyone else goes global."""

    def __init__(self):
        rules = {COORDINATOR_ADDRESS: endpoint(COORDINATOR_PORT), CHAT_CLIENT_ADDRESS: endpoint(CHAT_CLIENT_PORT)}
        rules.update({RETAILER_ADDRESSES[s]: endpoint(p) for s, p in RETAILER_PORTS.items()})
        self._local = RulesBasedResolver(rules)
        self._global = GlobalResolver()

    async def resolve(self, destination: str) -> tuple[str | None, list[str]]:
        address, endpoints = await self._local.resolve(destination)
        if endpoints:
            return address, endpoints
        return await self._global.resolve(destination)
