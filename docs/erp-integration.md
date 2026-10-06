# TAGHills ERP integration

Connects this CRM to the TAGHills ERP at `https://erp.taghills.com`.
Three separate things, which can be switched on independently:

| What | Where | Direction |
|---|---|---|
| Customer / order / payment events | `POST /api/erp/events` | ERP → CRM |
| Single sign-on into the embedded CRM | `GET /auth/erp` | ERP → CRM |
| "Open this customer's chat" | `GET /dashboard/inbox?phone=…` | ERP → CRM |

The ERP is the system of record for customers, orders and branches.
The CRM owns the messaging: which template, what wording, which
language, and whether the customer has opted out. The ERP deliberately
sends **events, never message text**.

## Setup

Two secrets, the same value on both sides:

| Meaning | ERP env name | CRM env name |
|---|---|---|
| Bearer token on every event request | `CRM_API_KEY` | `ERP_API_KEY` |
| HMAC-SHA256 key for signatures and SSO tokens | `CRM_SHARED_SECRET` | `ERP_SHARED_SECRET` |

Generate each with `openssl rand -hex 32`. Both are server-side only.
Until they are set, both endpoints refuse every request — the
integration fails closed, it does not fall open.

Three optional ones, documented in `.env.local.example`:
`ERP_ACCOUNT_ID` (only needed if more than one account in the
deployment has WhatsApp connected), `REVIEW_LINK_URL` (the review
page `thank_you_feedback` points at), and `ERP_SEND_ONLY_BRANCHES`
(the safety brake below).

### Templates

Each event sends an **approved** WhatsApp template. These must exist and
be approved in Settings → WhatsApp → Templates before the matching
event will deliver:

| Event | Template | Body variables, in order |
|---|---|---|
| `order.created` | `order_confirmation` | name, bill no, total, balance, delivery date |
| `order.ready` | `order_ready` | name, bill no, branch, balance |
| `order.delivered` | `thank_you_feedback` | name, review link |
| `payment.received` | `payment_receipt` | name, amount paid, bill no, balance |
| `customer.birthday` | `birthday_wish` | name |
| `customer.recall` | `eye_test_recall` | name, branch |

`customer.upsert` and `ping` send nothing. The mapping lives in
`src/lib/erp/events.ts` — that table is the editorial surface, and
changing a template name or a variable order there is how you change
what customers receive.

## Security

`POST /api/erp/events` requires **both** of:

```
Authorization: Bearer <ERP_API_KEY>
X-ERP-Signature: sha256=<hex of HMAC-SHA256(raw body, ERP_SHARED_SECRET)>
```

The signature is computed over the **raw body, before JSON parsing** —
verifying a re-serialised object would compare against bytes the sender
never signed. Both comparisons are constant time. Either check failing
is a flat `401` that says nothing about which one.

Manual test:

```bash
BODY='{"source":"taghills-erp","events":[{"id":"t1","type":"ping","data":{}}]}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$ERP_SHARED_SECRET" | sed 's/^.* //')
curl -i https://wa.taghills.com/api/erp/events \
  -H "Authorization: Bearer $ERP_API_KEY" \
  -H "X-ERP-Signature: sha256=$SIG" \
  -H 'Content-Type: application/json' -d "$BODY"
```

Expect `200 {}`.

## Idempotency

The ERP retries a failed batch 8 times with backoff, and may re-deliver
an event it already sent. `erp_events` (migration 049) records every
event id per account; a re-delivered id whose row is `done` or
`skipped` is ignored, so a customer never gets the same message twice.
Only rows recorded `failed` are open to a retry.

This is why a per-event problem never becomes a non-2xx response: a
4xx/5xx makes the ERP retry the **whole batch**, so one bad customer
record would re-send 99 good events. Per-event failures come back as
`200 {"failed":["1042"]}` instead.

The same ledger makes a slow bulk sync safe. The ERP delivers up to ten
batches of 100 concurrently; if one request times out mid-batch, the
events already recorded stay recorded, and the retry redoes only the
rest. A timeout costs time, never a duplicate contact or a duplicate
message.

## The send gate — running a trial on one branch

`ERP_SEND_ONLY_BRANCHES` limits which branches may actually send a
WhatsApp message. Comma-separated names or store codes, matched with
the same normalisation as store lookup, so `Demo Store`, `demo-store`
and `DEMO STORE` are one branch.

Unset, every branch sends — the behaviour every deployment has by
default. Set, only the named branches do.

Two reasons to use it:

**A demo store in the ERP.** A test order carries a real phone number,
and its branch name matches no CRM store. That mismatch is logged and
deliberately non-fatal, because the alternative is a typo in a real
branch name silencing a paying customer's message — so without this
gate the demo order sends that number a real "your order is ready".
Nothing in the data tells a demo store from a misspelt real one, so
the operator has to say.

**A staged rollout.** Run live on one shop for a week, then clear the
setting. Held-back events still create the contact, still link it to
its store, and still appear in that branch's inbox — only the outgoing
message is withheld, which is what makes it a trial rather than a
partial rollout.

Events with no branch at all (`customer.birthday`) are held back while
the gate is on. During a trial, "we could not tell which branch" is
not evidence that it is the allowed one.

Every held-back event is recorded in the ledger as `skipped` with a
reason naming both the event's branch and the allowed list, so
`/api/erp/status` shows exactly what the brake stopped. That endpoint
also reports the live value under
`configured.ERP_SEND_ONLY_BRANCHES` — as the list itself, not a
boolean, because knowing the gate is *on* is useless without knowing
which branches it admits.

## Stores

`contact_stores` is the staff-isolation boundary (migration 043), and a
sales order in the ERP is the trusted event that says which branch a
customer belongs to — hence `source = 'erp'`.

Order-shaped events carry a `branch` display name. It is matched against
each store's **name and short code**, ignoring case, spaces and
punctuation, so "Shastri Nagar", "shastri nagar" and "SHNR" all reach
the same store. A branch that matches nothing is logged and ignored: the
message still goes out, and the contact stays visible to owner/admin,
who can assign it by hand from the contact's Stores card.

Keep the store names/codes in Settings → Stores aligned with the ERP's
branch names. They do not have to match exactly, but they do have to
match after case and punctuation are stripped.

## Consent

`contacts.marketing_opt_out` is set when a customer replies **STOP**
(or `unsubscribe` / `opt out`), and cleared by **START**. The whole
message must be the keyword — "stop sending to Rohini, deliver to
Bahadurgarh" is a delivery instruction, not an opt-out.

Opting out stops `customer.birthday` and `customer.recall`. It does
**not** stop order and payment messages: those are service messages
about a transaction the customer chose to make, and suppressing them
would be a worse outcome than the opt-out was asking for.

The ERP never writes this flag. Consent was given to this channel, so
it is owned by this channel.

## Single sign-on

The ERP loads `https://wa.taghills.com/auth/erp?token=<payload>.<sig>`
inside its iframe. The token is base64url JSON plus a base64url HMAC of
the payload part, valid for 60 seconds.

Checks, in order: signature, then expiry, then ERP role (`admin`,
`owner`, `CompanyAdmin`, `manager`), then **CRM membership**.

That last one is a deliberate departure from the original handover,
which said to create the CRM user if none exists. Creating one here
would put them in a fresh, empty personal account — they would sign in
successfully and find a CRM with no contacts, no inbox and no WhatsApp,
which looks far more broken than being told they have no access. So:
**invite them from Settings → Team first**, with the same email address
the ERP holds. The refusal page says exactly that.

`next` is re-validated server side and must be a site-relative path;
absolute and protocol-relative URLs fall back to `/dashboard`.

### Cookies in the iframe

Session cookies are written `SameSite=None; Secure; Partitioned` in
production — a `Lax` cookie is simply not sent on a request from a
cross-site iframe, and the symptom is the login page appearing inside
the ERP no matter how many times you sign in. All four writers go
through `sessionCookieOptions()` in `src/lib/supabase/cookie-options.ts`
(SSR client, browser client, middleware refresh, SSO route); miss one
and that writer silently downgrades the cookie on its next write.

Development keeps the defaults, because `Secure` cookies are rejected
over `http://localhost`.

### Framing

`next.config.mjs` sends an enforcing
`Content-Security-Policy: frame-ancestors https://erp.taghills.com`
and no `X-Frame-Options` (which cannot express "this one other
origin"). No other site can embed the CRM.

## Opening a chat from the ERP

`/dashboard/inbox?phone=919999999999` finds or starts the conversation
for that number and redirects to `/inbox?c=<id>`.

The inbox itself lives at `/inbox` — `(dashboard)` is a route *group*
and contributes nothing to the URL. `/dashboard/inbox` exists because
the ERP is already deployed and links to it; it is a redirect, not a
second inbox.

Resolution runs under the signed-in user's own RLS client, so store
isolation applies: a staff member who may not see a customer cannot
reach their chat by guessing the number in the query string.

## Rollout

1. Set `ERP_API_KEY` and `ERP_SHARED_SECRET` on the CRM host, and the
   same values as `CRM_API_KEY` / `CRM_SHARED_SECRET` on the ERP.
2. ERP → Settings → CRM Connection → **Test connection** (sends a
   signed `ping`).
3. **Turn the connection ON**, with every message type still disabled.
4. **Sync all customers now** — `customer.upsert` events, which send no
   messages. Safe to run before any template exists.
5. Enable **one** message type and test it on a real number before
   enabling the rest.

> **Steps 3 and 4 are in this order for a reason.** The ERP's sync
> writes customers to an outbox, and a background job delivers it only
> while the connection is ON. Syncing first queues everything with
> nothing to send it: the ERP reports "625 customers added", the CRM
> receives nothing, and no error appears on either side. The original
> handover had these the other way round and that is exactly what
> happened on the first run.
>
> Nothing is lost when it does — the queue drains as soon as the switch
> goes on. `/api/erp/status` is how you tell the difference between
> "queued" and "delivered": `events.counts` stays empty in the first
> case.
