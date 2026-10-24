"""Async client for the agent gateway (shared/contracts/gateway.ts).

Every call is made as one organization via the X-Org-Id header. Gateway errors
({ok: false, error: {code, message}}) are raised as GatewayError.
"""

from typing import Any

import httpx

from shared.config import GATEWAY_URL


class GatewayError(Exception):
    def __init__(self, code: str, message: str, status: int = 0):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.status = status


class Gateway:
    def __init__(self, org_id: str, base_url: str = GATEWAY_URL, timeout: float = 10.0):
        self.org_id = org_id
        self._client = httpx.AsyncClient(base_url=base_url, timeout=timeout, headers={"X-Org-Id": org_id})

    async def _call(self, method: str, path: str, json: dict | None = None, params: dict | None = None) -> dict[str, Any]:
        try:
            res = await self._client.request(method, path, json=json, params=params)
        except httpx.HTTPError as e:
            raise GatewayError("GATEWAY_UNREACHABLE", f"{method} {path}: {e}") from e
        try:
            body = res.json()
        except ValueError:
            raise GatewayError("UNKNOWN", f"{method} {path}: HTTP {res.status_code} non-JSON response", res.status_code)
        if not body.get("ok"):
            err = body.get("error") or {}
            raise GatewayError(err.get("code", "UNKNOWN"), err.get("message", f"HTTP {res.status_code}"), res.status_code)
        return body

    # ---- reads
    async def health(self):
        return await self._call("GET", "/health")

    async def get_lot(self, lot_id: str) -> dict:
        return (await self._call("GET", f"/lots/{lot_id}"))["lot"]

    async def recall_status(self, recall_id: str) -> dict:
        return await self._call("GET", f"/recalls/{recall_id}/status")

    async def report_facts(self, recall_id: str) -> dict:
        return (await self._call("GET", f"/recalls/{recall_id}/report"))["facts"]

    async def get_task(self, task_id: str) -> dict:
        return (await self._call("GET", f"/tasks/{task_id}"))["task"]

    async def inventory(self, location_id: str) -> list[dict]:
        return (await self._call("GET", f"/locations/{location_id}/inventory"))["balances"]

    # ---- coordinator (manufacturer identity)
    async def report_recall_signal(self, root_lot_id: str, reason: str) -> dict:
        return (await self._call("POST", "/recalls", json={"rootLotId": root_lot_id, "reason": reason}))["recall"]

    async def authorize_recall(self, recall_id: str) -> dict:
        return (await self._call("POST", f"/recalls/{recall_id}/authorize"))["recall"]

    async def trace_recall(self, recall_id: str) -> dict:
        return await self._call("POST", f"/recalls/{recall_id}/trace")

    async def assign_containment_tasks(self, recall_id: str) -> dict:
        return await self._call("POST", f"/recalls/{recall_id}/assign")

    # ---- retailer
    async def claim_task(self, task_id: str) -> dict:
        return (await self._call("POST", f"/tasks/{task_id}/claim"))["task"]

    async def quarantine_lot(self, task_id: str) -> dict:
        return await self._call("POST", f"/tasks/{task_id}/quarantine")

    async def aclose(self):
        await self._client.aclose()
