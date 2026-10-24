"""Env-driven settings shared by both agents. Reads the repo-root .env."""

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / ".env")

GATEWAY_URL = os.getenv("GATEWAY_URL", "http://localhost:4000")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
AGENTVERSE_API_KEY = os.getenv("AGENTVERSE_API_KEY", "")
# Mailbox connects the agent to Agentverse (needed for ASI:One). Off by default for local dev.
AGENT_MAILBOX = os.getenv("AGENT_MAILBOX", "false").lower() == "true"
