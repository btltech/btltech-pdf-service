# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 BTLTECH LTD
"""The PayPal calls, kept behind one small interface.

Two reasons this is its own file rather than part of the endpoints.

The first is testing. The rest of the paid flow - who may convert, what a pack
costs, that a credit is returned when a conversion fails, that one order can
never be granted twice - is logic worth testing hard, and none of it should need
a PayPal account to run. The suite swaps this module for a fake.

The second is trust. Card details never reach this service: the customer
approves the payment on PayPal's own pages, and this code only creates the order
and then asks PayPal what actually happened. The credit is granted on PayPal's
answer, never on the browser's claim - a browser that says "I paid" is a browser
that can say anything.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import httpx

import config

LIVE = "https://api-m.paypal.com"
SANDBOX = "https://api-m.sandbox.paypal.com"


def base_url() -> str:
    return LIVE if config.PAYPAL_ENV == "live" else SANDBOX


def configured() -> bool:
    return bool(config.PAYPAL_CLIENT_ID and config.PAYPAL_SECRET)


class PayPalError(RuntimeError):
    """Something went wrong talking to PayPal, with a message fit to show."""


@dataclass
class Capture:
    """What PayPal says happened, which is the only version that counts."""

    order_id: str
    status: str
    amount: str
    currency: str

    @property
    def completed(self) -> bool:
        return self.status == "COMPLETED"


async def _token(client: httpx.AsyncClient) -> str:
    r = await client.post(
        f"{base_url()}/v1/oauth2/token",
        auth=(config.PAYPAL_CLIENT_ID, config.PAYPAL_SECRET),
        data={"grant_type": "client_credentials"},
        headers={"Accept": "application/json"},
    )
    if r.status_code != 200:
        raise PayPalError("could not authenticate with PayPal")
    return r.json()["access_token"]


async def create_order(amount: str, currency: str, description: str) -> tuple[str, str]:
    """Start a payment; return the order id and the page the customer approves on.

    The approval link comes from PayPal's own reply rather than being built here,
    so the sandbox and the live site each send the customer to the right place
    without this code having to know which it is talking to.
    """
    if not configured():
        raise PayPalError("payments are not configured on this server")
    async with httpx.AsyncClient(timeout=20) as client:
        token = await _token(client)
        r = await client.post(
            f"{base_url()}/v2/checkout/orders",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={
                "intent": "CAPTURE",
                "purchase_units": [
                    {
                        "amount": {"currency_code": currency, "value": amount},
                        "description": description[:127],
                    }
                ],
            },
        )
    if r.status_code not in (200, 201):
        raise PayPalError("PayPal would not start the payment")
    data = r.json()
    approve = next((l["href"] for l in data.get("links", []) if l.get("rel") == "approve"), "")
    if not approve:
        raise PayPalError("PayPal did not say where to send the customer")
    return data["id"], approve


async def capture_order(order_id: str) -> Capture:
    """Take the money and report what PayPal says, including how much."""
    if not configured():
        raise PayPalError("payments are not configured on this server")
    async with httpx.AsyncClient(timeout=30) as client:
        token = await _token(client)
        r = await client.post(
            f"{base_url()}/v2/checkout/orders/{order_id}/capture",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                     "PayPal-Request-Id": order_id},          # PayPal's own idempotency key
            json={},
        )
    if r.status_code not in (200, 201):
        # An order already captured comes back as an error; ask what its state is
        # rather than assuming the worst, because the customer has paid either way.
        detail = ""
        try:
            detail = r.json().get("details", [{}])[0].get("issue", "")
        except Exception:                                      # noqa: BLE001
            pass
        if detail == "ORDER_ALREADY_CAPTURED":
            return await read_order(order_id)
        raise PayPalError("PayPal did not complete the payment")
    data = r.json()
    return _read_capture(order_id, data)


async def read_order(order_id: str) -> Capture:
    """Ask PayPal about an order without changing it."""
    async with httpx.AsyncClient(timeout=20) as client:
        token = await _token(client)
        r = await client.get(
            f"{base_url()}/v2/checkout/orders/{order_id}",
            headers={"Authorization": f"Bearer {token}"},
        )
    if r.status_code != 200:
        raise PayPalError("PayPal could not be asked about that payment")
    return _read_capture(order_id, r.json())


def _read_capture(order_id: str, data: dict) -> Capture:
    """Pull the amount PayPal actually took out of its reply."""
    status = data.get("status", "")
    amount, currency = "0.00", config.CURRENCY
    try:
        unit = data["purchase_units"][0]
        captures = unit.get("payments", {}).get("captures", [])
        source = captures[0]["amount"] if captures else unit["amount"]
        amount = str(source["value"])
        currency = str(source["currency_code"])
    except (KeyError, IndexError, TypeError):
        pass
    return Capture(order_id=order_id, status=status, amount=amount, currency=currency)
