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

# Claude (coordinator only). Model and cache file for demo-safe replays (PLAN.md section 13).
CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "claude-opus-5-5")
CLAUDE_CACHE_PATH = Path(os.getenv("CLAUDE_CACHE_PATH", Path(__file__).resolve().parents[1] / "claude_cache.json"))
# Seconds to wait for Claude before falling back to the deterministic parser/template.
CLAUDE_TIMEOUT_S = float(os.getenv("CLAUDE_TIMEOUT_S", "20"))

# Coordinator polling of GET /recalls/:id/status.
POLL_INTERVAL_S = float(os.getenv("POLL_INTERVAL_S", "3"))
