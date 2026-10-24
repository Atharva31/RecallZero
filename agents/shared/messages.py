"""Agent message contract. Mirrors shared/contracts/messages.json (PLAN.md section 9).

FROZEN CONTRACT: only Atharva edits this file, announced in team chat first.
These subclass uagents.Model (a Pydantic model) so they can be sent between agents directly.
"""

from typing import List, Literal, Optional

from uagents import Model

AffectedLocationStatus = Literal[
    "AWAITING_ACKNOWLEDGMENT",
    "VERIFIED_CONTAINED",
    "PARTIALLY_CONTAINED",
    "INVENTORY_UNKNOWN",
    "ACTION_FAILED",
    "RECONCILIATION_EXCEPTION",
]


class QuarantineRequest(Model):
    type: Literal["QUARANTINE_REQUEST"] = "QUARANTINE_REQUEST"
    request_id: str  # "REQ-204"
    recall_id: str  # "REC-001"
    task_id: str  # "T-7"
    store_id: str  # "STORE-A"
    lot_ids: List[str]  # ["BAR-100"]
    reason: str  # "Authorized recall"


class QuarantineResult(Model):
    type: Literal["QUARANTINE_RESULT"] = "QUARANTINE_RESULT"
    request_id: str
    task_id: str
    status: AffectedLocationStatus  # read back from the database after commit
    quarantined_units: int
    error: Optional[str] = None
