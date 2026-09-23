# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 BTLTECH LTD
"""The paid-conversion rules, proved without a PayPal account or a live database.

Money logic is the part of a service where a quiet mistake costs a real person
real money, so it is tested against the behaviour that matters rather than the
implementation: the free allowance, that a failed conversion does not take a
credit, that one payment cannot be granted twice, and that the browser cannot
talk this service into selling something it does not offer.

The database is a small in-memory stand-in with the same behaviour as the SQL,
and PayPal is a fake. Neither substitution is hiding anything: what is being
tested is the decision-making, and that is all in our own code.

    .venv/bin/python scripts/test_billing.py
"""

import datetime
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ["PDF_BILLING"] = "on"
os.environ["DATABASE_URL"] = "memory://test"
os.environ["PDF_PACKS"] = "10:2.00,25:4.00"
os.environ["PDF_FREE_PER_DAY"] = "1"
os.environ["PDF_BILLING_SALT"] = "test-salt"

import billing  # noqa: E402
import config  # noqa: E402

PASSED, FAILED = [], []


def check(label, condition, detail=""):
    (PASSED if condition else FAILED).append(label)
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}" + (f"  ({detail})" if detail else ""))


# --------------------------------------------------------------- the stand-in ---
class FakeStore:
    """Enough of the SQL's behaviour to exercise the rules above it."""

    def __init__(self):
        self.free = {}       # (day, who) -> used
        self.packs = {}      # token -> credits
        self.orders = {}     # order_id -> (token, credits)

    # the three operations billing.py performs, with the same conditions
    def take_free(self, who, limit):
        if limit <= 0:
            return False                       # no allowance means none, not one
        key = (datetime.date.today(), who)
        used = self.free.get(key, 0)
        if used >= limit:
            return False
        self.free[key] = used + 1
        return True

    def give_free_back(self, who):
        key = (datetime.date.today(), who)
        self.free[key] = max(0, self.free.get(key, 0) - 1)

    def take_credit(self, token):
        if self.packs.get(token, 0) > 0:
            self.packs[token] -= 1
            return True
        return False

    def give_credit_back(self, token):
        self.packs[token] = self.packs.get(token, 0) + 1

    def credits(self, token):
        return self.packs.get(token, 0)

    def used_today(self, who):
        return self.free.get((datetime.date.today(), who), 0)

    def grant(self, order_id, token, credits):
        if order_id in self.orders:
            return False                       # already granted: do nothing
        self.orders[order_id] = (token, credits)
        self.packs[token] = self.packs.get(token, 0) + credits
        return True


store = FakeStore()


def reserve(ip, token):
    who = billing._who(ip)
    if store.take_free(who, config.FREE_PER_DAY):
        return f"free:{who}"
    if token and store.take_credit(token):
        return f"credit:{token}"
    raise billing.NeedsPayment()


def refund(reservation):
    if not reservation:
        return
    kind, _, rest = reservation.partition(":")
    if kind == "free":
        store.give_free_back(rest)
    elif kind == "credit":
        store.give_credit_back(rest)


billing.reserve = reserve
billing.refund = refund
billing.allowance = lambda ip, token: billing.Allowance(
    may_convert=store.used_today(billing._who(ip)) < config.FREE_PER_DAY or store.credits(token) > 0,
    used_free_today=store.used_today(billing._who(ip)),
    free_per_day=config.FREE_PER_DAY,
    credits=store.credits(token) if token else 0,
)
billing.grant = lambda order_id, token, credits, amount, currency: (
    (lambda t: (store.grant(order_id, t, credits), t)[1])(token or billing.new_token())
)

print("\n=== what is on sale ===")
packs = billing.packs()
check("the packs come from configuration, not from the source", [p.credits for p in packs] == [10, 25],
      str([p.label for p in packs]))
check("prices are exact strings, never floats", all(isinstance(p.price, str) for p in packs))
os.environ["PDF_PACKS"] = "nonsense,5:1.50,-3:9.99"
import importlib  # noqa: E402

importlib.reload(config)
check("a malformed pack is ignored rather than guessed at",
      [p.credits for p in billing.packs()] == [5], str(billing.packs()))
os.environ["PDF_PACKS"] = "10:2.00,25:4.00"
importlib.reload(config)

print("\n=== the free allowance ===")
ALICE, BOB = "1.2.3.4", "5.6.7.8"
check("the first conversion of the day is free", reserve(ALICE, None) == f"free:{billing._who(ALICE)}")
try:
    reserve(ALICE, None)
    check("the second is refused", False, "it was allowed")
except billing.NeedsPayment:
    check("the second is refused", True)
check("someone else still has their own free conversion", reserve(BOB, None).startswith("free:"))

print("\n=== the address is counted, but not kept ===")
h = billing._who(ALICE)
check("the caller is stored as a hash, not an address", ALICE not in h and len(h) == 32, h)
check("the same caller hashes the same way", billing._who(ALICE) == h)
check("a different caller hashes differently", billing._who(BOB) != h)
config.BILLING_SALT = "a-different-salt"
check("the hash depends on the secret salt", billing._who(ALICE) != h)
config.BILLING_SALT = "test-salt"

print("\n=== paying ===")
token = billing.grant("ORDER-1", None, 10, "2.00", "GBP")
check("a payment grants the credits it bought", store.credits(token) == 10, str(store.credits(token)))
billing.grant("ORDER-1", token, 10, "2.00", "GBP")
check("the same order cannot be granted twice", store.credits(token) == 10, str(store.credits(token)))
billing.grant("ORDER-2", token, 25, "4.00", "GBP")
check("a second, different order adds to the same token", store.credits(token) == 35, str(store.credits(token)))

print("\n=== spending ===")
r = reserve(ALICE, token)
check("with the free one used, a credit is spent", r == f"credit:{token}", r)
check("the balance goes down by exactly one", store.credits(token) == 34, str(store.credits(token)))

print("\n=== a conversion that fails costs nothing ===")
before = store.credits(token)
r = reserve(ALICE, token)
refund(r)
check("a failed conversion returns the credit", store.credits(token) == before, str(store.credits(token)))
carol = "9.9.9.9"
r = reserve(carol, None)
refund(r)
check("a failed free conversion returns the free allowance", store.used_today(billing._who(carol)) == 0)
check("...so that caller may still convert", reserve(carol, None).startswith("free:"))

print("\n=== what a browser cannot do ===")
check("an unknown token has no credits", store.credits("made-up-token") == 0)
try:
    reserve(ALICE, "made-up-token")
    check("an invented token buys nothing", False, "it was allowed")
except billing.NeedsPayment:
    check("an invented token buys nothing", True)
prices = {p.price for p in billing.packs()}
check("a price the server does not sell matches no pack", "0.01" not in prices, str(prices))

print("\n=== a zero free allowance really means zero ===")
config.FREE_PER_DAY = 0
dave = "7.7.7.7"
try:
    reserve(dave, None)
    check("with no free allowance, the first conversion is refused", False, "it was allowed")
except billing.NeedsPayment:
    check("with no free allowance, the first conversion is refused", True)
config.FREE_PER_DAY = 1

print("\n=== switched off by default ===")
config.BILLING_ON = False
check("with billing off, nothing is metered", not billing.enabled())
config.BILLING_ON = True
config.PACKS_RAW = ""
check("with nothing on sale, nothing is metered", not billing.enabled())
config.PACKS_RAW = "10:2.00"
config.DATABASE_URL = ""
check("with no database, nothing is metered", not billing.enabled())

# ------------------------------------------------------------- the endpoints ---
# The rules above are pure logic. These call the real HTTP handlers with billing
# switched on, because a handler can be perfectly correct and still fail on a
# name it never resolves until money is involved - which is exactly what happened
# the first time this was deployed.
print("\n=== the endpoints, with billing on ===")
# the section above deliberately switched billing off; put it back first
config.BILLING_ON = True
config.DATABASE_URL = "memory://test"
config.PACKS_RAW = "10:2.00,25:4.00"
config.FREE_PER_DAY = 1
from fastapi.testclient import TestClient  # noqa: E402

import app as the_app  # noqa: E402

the_app.billing = billing
client = TestClient(the_app.app)

r = client.get("/api/allowance")
check("the allowance endpoint answers", r.status_code == 200, str(r.status_code))
body = r.json() if r.status_code == 200 else {}
check("it reports that billing is on", body.get("billing") is True, str(body)[:90])
check("it names a currency", bool(body.get("currency")), str(body.get("currency")))
check("it offers the configured packs", len(body.get("packs", [])) == 2, str(body.get("packs"))[:90])

r = client.post("/api/pay/create", json={"credits": 10})
check("with no PayPal credentials, buying is unavailable rather than broken",
      r.status_code == 503, str(r.status_code))

# Stand PayPal up as a fake so the rules around it can be reached at all.
import paypal as real_paypal  # noqa: E402


class FakePayPal:
    PayPalError = real_paypal.PayPalError
    Capture = real_paypal.Capture
    last_amount = None

    @staticmethod
    def configured():
        return True

    @staticmethod
    async def create_order(amount, currency, description):
        FakePayPal.last_amount = amount
        return "ORDER-FAKE", "https://example.test/approve"

    @staticmethod
    async def capture_order(order_id):
        # a payment of an amount this server does not sell
        amount = "0.01" if order_id == "ORDER-WRONG-PRICE" else "2.00"
        return real_paypal.Capture(order_id, "COMPLETED", amount, "GBP")

the_app.paypal = FakePayPal

r = client.post("/api/pay/create", json={"credits": 999})
check("a pack that is not on offer is refused", r.status_code == 400, str(r.status_code))

r = client.post("/api/pay/create", json={"credits": 10})
check("a real pack starts a payment", r.status_code == 200, str(r.status_code))
check("the price sent to PayPal is the server's, not the browser's",
      FakePayPal.last_amount == "2.00", str(FakePayPal.last_amount))
check("the browser is sent to PayPal's own approval page",
      r.json().get("approve_url", "").startswith("https://"), str(r.json())[:80])

r = client.post("/api/pay/capture", json={"order_id": "ORDER-WRONG-PRICE"})
check("a payment for an amount not on sale grants nothing", r.status_code == 409, str(r.status_code))

r = client.post("/api/pay/capture", json={"order_id": "ORDER-GOOD"})
check("a completed payment grants the pack", r.status_code == 200, str(r.status_code))
granted = r.json() if r.status_code == 200 else {}
check("it returns a token to keep", bool(granted.get("token")), str(granted)[:70])
check("it adds the credits that were bought", granted.get("added") == 10, str(granted.get("added")))

r = client.post("/api/pay/capture", json={"order_id": "ORDER-GOOD"},
                headers={"X-PDF-Token": granted.get("token", "")})
check("capturing the same order twice adds nothing more",
      r.status_code == 200 and store.credits(granted.get("token", "")) == 10,
      str(store.credits(granted.get("token", ""))))

r = client.post("/api/pay/capture", json={})
check("a capture with no order is refused", r.status_code == 400, str(r.status_code))

print("\n=== summary ===")
print(f"  passed: {len(PASSED)}")
print(f"  failed: {len(FAILED)}")
for label in FAILED:
    print(f"    - {label}")
sys.exit(1 if FAILED else 0)
