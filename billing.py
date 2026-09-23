# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 BTLTECH LTD
"""Metering and credit for the server-side conversion.

What is charged for, and why only this. The two editors run in the customer's
browser: a payment check inside them could be lifted by anyone who looked, so
gating them would be theatre. PDF -> Word runs here, costs real processing, and
can genuinely be withheld. That is the thing worth charging for.

How someone is counted, without accounts:

* The **free allowance** is counted against a salted hash of the caller's IP
  address for the current day. The address itself is never stored, the salt is a
  secret, and the rows are deleted after two days. This is not perfect - a phone
  on mobile data gets a new address, an office shares one - but it is the least
  that works, and it holds no identity.
* **Paid credits** belong to an opaque token the customer's browser keeps. No
  name, no email, no account. Whoever holds the token holds the credits, which
  is the same bargain as a cinema ticket, and it is said plainly in the UI.

Everything is off unless `PDF_BILLING=on` and a database and at least one pack
are configured. With billing off the service behaves exactly as it did before:
unlimited and free. That is deliberate - a half-configured deployment should
give the service away, never take money it cannot account for.
"""

from __future__ import annotations

import hashlib
import os
import secrets
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator, List, Optional

import config

_pool = None


# --------------------------------------------------------------------- packs ---
@dataclass(frozen=True)
class Pack:
    """One thing a customer can buy: a number of conversions for a price."""

    credits: int
    price: str          # as a decimal string, e.g. "2.00" - never a float

    @property
    def label(self) -> str:
        return f"{self.credits} conversions for {config.CURRENCY_SYMBOL}{self.price}"


def packs() -> List[Pack]:
    """Packs from PDF_PACKS, e.g. "10:2.00,25:4.00". Order is preserved."""
    out: List[Pack] = []
    for item in config.PACKS_RAW.split(","):
        item = item.strip()
        if not item:
            continue
        try:
            credits, price = item.split(":", 1)
            n = int(credits)
            # normalise to two decimal places without going near a float
            pounds, _, pence = price.strip().partition(".")
            price = f"{int(pounds)}.{(pence + '00')[:2]}"
            if n > 0:
                out.append(Pack(n, price))
        except (ValueError, TypeError):
            continue          # a malformed pack is ignored, never guessed at
    return out


def enabled() -> bool:
    """Billing only applies when it is switched on AND fully configured."""
    return bool(config.BILLING_ON and config.DATABASE_URL and packs())


# ------------------------------------------------------------------ database ---
def _connect():
    global _pool
    if _pool is None:
        import psycopg_pool                                   # imported lazily

        _pool = psycopg_pool.ConnectionPool(config.DATABASE_URL, min_size=1, max_size=4, open=True)
    return _pool


@contextmanager
def _cursor() -> Iterator:
    with _connect().connection() as conn:
        with conn.cursor() as cur:
            yield cur


SCHEMA = """
CREATE TABLE IF NOT EXISTS credit_pack (
    token      TEXT PRIMARY KEY,
    credits    INTEGER NOT NULL CHECK (credits >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS paid_order (
    order_id    TEXT PRIMARY KEY,
    token       TEXT NOT NULL,
    credits     INTEGER NOT NULL,
    amount      TEXT NOT NULL,
    currency    TEXT NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS free_use (
    day  DATE NOT NULL,
    who  TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, who)
);
"""


def setup() -> None:
    """Create the tables if they are missing. Safe to call on every start."""
    if not enabled():
        return
    with _cursor() as cur:
        cur.execute(SCHEMA)
        # the free-tier rows are a counter, not a record worth keeping
        cur.execute("DELETE FROM free_use WHERE day < CURRENT_DATE - INTERVAL '2 days'")


# ------------------------------------------------------------------ counting ---
def _who(ip: str) -> str:
    """A day-scoped, salted hash of the caller. Not reversible to an address."""
    material = f"{config.BILLING_SALT}|{ip}".encode()
    return hashlib.sha256(material).hexdigest()[:32]


def new_token() -> str:
    """An opaque bearer token for a pack of credits."""
    return secrets.token_urlsafe(24)


@dataclass
class Allowance:
    """What the caller may do right now, and why."""

    may_convert: bool
    used_free_today: int
    free_per_day: int
    credits: int
    reason: str = ""

    @property
    def free_left(self) -> int:
        return max(0, self.free_per_day - self.used_free_today)


def allowance(ip: str, token: Optional[str]) -> Allowance:
    """Report what is available without consuming anything."""
    if not enabled():
        return Allowance(True, 0, 0, 0, "billing is not switched on")
    with _cursor() as cur:
        cur.execute("SELECT used FROM free_use WHERE day = CURRENT_DATE AND who = %s", (_who(ip),))
        row = cur.fetchone()
        used = row[0] if row else 0
        credits = 0
        if token:
            cur.execute("SELECT credits FROM credit_pack WHERE token = %s", (token,))
            row = cur.fetchone()
            credits = row[0] if row else 0
    free_left = max(0, config.FREE_PER_DAY - used)
    return Allowance(
        may_convert=free_left > 0 or credits > 0,
        used_free_today=used,
        free_per_day=config.FREE_PER_DAY,
        credits=credits,
    )


class NeedsPayment(Exception):
    """Raised when there is no free allowance left and no credit to spend."""


def reserve(ip: str, token: Optional[str]) -> Optional[str]:
    """Take one conversion, free allowance first. Returns what to refund on failure.

    The charge happens BEFORE the work, so two requests at once cannot both
    spend the last credit; if the conversion then fails, `refund` puts it back.
    Charging for a conversion that did not happen would be worse than the small
    chance of a credit being returned twice, which cannot happen because the
    refund is tied to this one reservation.
    """
    if not enabled():
        return None
    who = _who(ip)
    with _cursor() as cur:
        # The limit has to be checked on the way in as well as on conflict: with
        # no free allowance at all there is no existing row to conflict with, so
        # the insert would otherwise succeed and give away the first conversion.
        if config.FREE_PER_DAY > 0:
            cur.execute(
                """
                INSERT INTO free_use (day, who, used) VALUES (CURRENT_DATE, %s, 1)
                ON CONFLICT (day, who) DO UPDATE SET used = free_use.used + 1
                WHERE free_use.used < %s
                RETURNING used
                """,
                (who, config.FREE_PER_DAY),
            )
            if cur.fetchone():
                return f"free:{who}"
        if token:
            cur.execute(
                "UPDATE credit_pack SET credits = credits - 1, updated_at = now() "
                "WHERE token = %s AND credits > 0 RETURNING credits",
                (token,),
            )
            if cur.fetchone():
                return f"credit:{token}"
    raise NeedsPayment()


def refund(reservation: Optional[str]) -> None:
    """Put back what `reserve` took, because the conversion did not happen."""
    if not reservation or not enabled():
        return
    with _cursor() as cur:
        if reservation.startswith("free:"):
            cur.execute(
                "UPDATE free_use SET used = GREATEST(0, used - 1) "
                "WHERE day = CURRENT_DATE AND who = %s",
                (reservation.split(":", 1)[1],),
            )
        elif reservation.startswith("credit:"):
            cur.execute(
                "UPDATE credit_pack SET credits = credits + 1, updated_at = now() WHERE token = %s",
                (reservation.split(":", 1)[1],),
            )


def grant(order_id: str, token: Optional[str], credits: int, amount: str, currency: str) -> str:
    """Add credits for a captured payment. Doing this twice for one order does nothing.

    The order id is the primary key, so a duplicate capture - a retried request,
    a double-clicked button, a replayed webhook - cannot grant the credits twice.
    """
    token = token or new_token()
    with _cursor() as cur:
        cur.execute(
            "INSERT INTO paid_order (order_id, token, credits, amount, currency) "
            "VALUES (%s, %s, %s, %s, %s) ON CONFLICT (order_id) DO NOTHING RETURNING order_id",
            (order_id, token, credits, amount, currency),
        )
        if not cur.fetchone():
            return token                                  # already granted
        cur.execute(
            "INSERT INTO credit_pack (token, credits) VALUES (%s, %s) "
            "ON CONFLICT (token) DO UPDATE SET credits = credit_pack.credits + EXCLUDED.credits, "
            "updated_at = now()",
            (token, credits),
        )
    return token


def caller_ip(request) -> str:
    """The caller's address, trusting the proxy header the host actually sets."""
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"
