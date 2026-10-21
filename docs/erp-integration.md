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
| `order.created` | `order_confirmation` | name, branch, bill no, total, paid, balance, branch phone |
| `order.created` + PDF | `order_confirmation_doc` | the same seven, plus a receipt PDF header |
| `order.ready` | `order_ready` | name, bill no, branch, balance, branch phone |
| `order.delivered` | `order_delivered` | name, bill no, branch, branch phone |
| `order.delivered` + PDF | `order_delivered_invoice` | the same four, plus an invoice PDF header |
| `order.sold` | `counter_sale` | name, branch, bill no, amount paid, branch phone |
| `order.sold` + PDF | `counter_sale_doc` | the same five, plus a receipt PDF header |
| `order.review` | `review_request` | name, branch, branch phone (review link on the button) |
| `customer.recall` | `eye_test_recall` | name, branch, branch phone |

`customer.upsert` and `ping` send nothing. `payment.received` and
`customer.birthday` are **deliberately unmapped**: no template was ever
written or approved for them, and naming a template Meta does not have
fails at the API. They record "no template mapped" until someone writes
them.

The mapping lives in `src/lib/erp/events.ts` — that table is the
editorial surface, and changing a template name or a variable order
there is how you change what customers receive.

The attachment is named after the document, not the event:
`receiptPdf` becomes `Receipt-TH-0001.pdf` and `invoicePdf` becomes
`Invoice-TH-0001.pdf`, wherever each arrived. The two fields fall back
to each other when the preferred one is empty, so naming the file after
the event handed the customer an invoice called `Receipt-…` — a name
that contradicts its contents.

#### The counter sale

`order.sold` is a bill with no lens lines, saved as delivered at
creation — sunglasses, a case, a cleaning kit. The ERP sends it
*instead of* `order.created` and `order.delivered`, with an identical
payload.

It exists because the three-step wording is wrong for it. Sent as a
creation followed by a delivery, a counter sale put two messages
seconds apart on the customer's phone, the first promising to tell
them when their purchase was "ready for collection" — for something
already in their bag.

Its template carries no balance: it is answered by the customer
standing at the counter, and `Balance: ₹0` on a paid-in-full sale
reads like a mistake.

It queues a review request, exactly as a delivery does. Keying that on
`order.delivered` alone would have asked every spectacles customer and
no sunglasses customer, silently, for as long as nobody counted.

#### Why two templates per PDF

Meta fixes a template's shape at approval. A template approved **with**
a document header must carry a document on every send; one approved
**without** can never gain one. So "attach the receipt when the ERP
gives us a link" is two approved templates, and the plan picks between
them per order.

Their wording is the same **except for the sentence about the
attachment**: `order_delivered_invoice` says "Your invoice is attached
for your records" and `order_delivered` does not, because the plain
one has nothing attached. A pair whose wording were copied verbatim
would promise a file that is not there — the one difference that is
not a drift to be fixed. The ERP supplies the link as
`receiptPdf` on `order.created` and `invoicePdf` on `order.delivered`;
both are optional, and a non-`https` link is ignored rather than sent,
because Meta's servers fetch the file and an `http` failure surfaces
there instead of here.

#### The review request's delay

`order.delivered` arrives the moment an order is handed over, but the
review request should not go out then. So delivery queues a row in
`erp_review_queue` (migration 052), due `review_delay_days` later, and
`GET /api/erp/review/cron` drains it.

The delay is a per-account setting, edited at **Settings → Automatic
messages**.

The **review link is per store**, edited at **Settings → Stores**.

The template's button points at `https://wa.taghills.com/r/{{1}}`, and
the send fills `{{1}}` with the serving store's id. Meta allows one
variable on a URL button and only as a suffix on a fixed base, so the
branch's own Google link cannot go on the button — four shops have four
unrelated links and there is no fixed base to hang them off. `/r/<store
id>` (public, `src/app/r/[id]/route.ts`) resolves it at tap time, which
also means a review link changed in Settings takes effect on the next
message with no Meta re-approval.

Google attaches reviews to a location, so each branch has its own
listing, its own star rating and its own link; one link for a
multi-branch business puts every review on the wrong branch's listing.
The account-wide link in Settings → Automatic messages is the fallback
for a store that has none yet, which is what lets the links be
collected one branch at a time. When neither exists the review request
is skipped, naming the store.

Delivery queues the row **whether or not a link exists yet**. The drain
is the one place that decides, because it runs days later, against the
serving branch, by which time a link may well have been filled in.
Gating the queue on the account-wide link instead dropped every
delivery at a branch that had its own listing, recorded nothing, and
left "no review message ever arrived" with no evidence anywhere.

**The ERP owns the links.** Order events carry an optional
`branchReviewUrl`, and the matched store's `review_url` is updated
from it. They are entered once in Staff & Stores, which also converts
a bare Place ID or a `g.page/r/…` share link into one that opens the
review box rather than the shop page — a plain `maps.app.goo.gl` or
`google.com/maps` link opens the listing and asks the customer to sign
in first, which loses most of them.

The sync can SET or CHANGE a link, never clear one. An event without
the field — an older ERP build, or a store whose link has not been
pasted in yet — must not wipe a link someone typed into Settings →
Stores. "The ERP said nothing" is not "the ERP said none", and only
one of those is a reason to stop asking customers for reviews.

The link still reaches the customer through `/r/<store id>`, read at
TAP time. That matters more here than it looks: the review request
sends days after the event, so a link carried on the event would
already be stale, and one pasted in between would not reach the
customer waiting on it.

`/api/erp/status` reports `hasPhone` and `hasReviewLink` per store, so
an unfilled branch is visible before it costs a message. The link previously lived in
`REVIEW_LINK_URL`; that variable is still honoured as a fallback, but a
value saved in Settings wins.

**Nothing in this app is scheduled**, and Hostinger's Node app hosting
has no cron of its own, so the clock lives in GitHub Actions:
`.github/workflows/review-cron.yml` calls the endpoint daily and can
be run by hand from the Actions tab.

Do not trust the nominal time. GitHub delays scheduled runs, and on
this repository the delay has been **six to seven hours, every day**:
a 03:30 UTC schedule fired at 10:00, 10:10, 10:45, 10:46 and 11:07, so
requests arrived around 16:00 IST rather than 09:00. The schedule is
off `:30` and `:00` because those are the congested minutes, but the
delay is GitHub's to give. A deployment that needs the message to
arrive at a known hour needs a different scheduler, not a different
cron line.

The nominal time is deliberately NOT wound back to compensate: a run
that is not delayed sends immediately, so scheduling for the delay
would message customers in the middle of the night on any day GitHub
happens to be punctual. It needs
`AUTOMATION_CRON_SECRET` as a repository secret, matching the app's own
environment variable of the same name — the same secret the automation
and flow crons use, so this is one more URL rather than one more
secret. The endpoint returns 503 until the app has that variable set,
and the workflow fails loudly (which emails you) on anything but a 200.

Any other scheduler works the same way: `GET` the endpoint with the
secret in the `x-cron-secret` header.

GitHub disables scheduled workflows in a repository idle for 60 days.
If review requests stop, check the workflow is still enabled first. Once a day is enough, since the delay is measured in
days. Running it more often is harmless: a row is claimed before it is
sent, so overlapping runs cannot send twice.

`/api/erp/status` reports the queue under `reviewQueue`. `overdue:
true` or `cronConfigured: false` both mean nothing is draining it.

The ERP may still send `order.review` itself. If it does for an order
the CRM already queued, the queued row is marked skipped rather than
sending a second ask.

The review request is classed as marketing: **STOP** silences it, and
it is submitted to Meta as MARKETING because a review request is not
about completing the customer's order. The opt-out is re-checked at
send time, not only at delivery — the customer had days to change
their mind.

Everything else the live path checks is re-checked too, for the same
reason: the send gate, the store's phone number, and whether a review
link is still configured.

#### Every template names the branch's phone

All six close by naming the serving branch's own contact number, taken
from `stores.phone` for the store matched to the event's branch. A
store with no number **cannot send**: the event is skipped with
`store <name> has no contact number`, because Meta rejects an empty
parameter and a message reading "call us on " is worse than no message.
Fill it in at Settings → Stores.

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

Expect `200` with a `results` array naming that event's outcome.

### What the response says

Every event comes back with its own outcome, in the order sent:

```json
{ "results": [
  { "eventId": "2700", "status": "sent",
    "reason": "sent order_confirmation_doc | filed to bardoli" },
  { "eventId": "2701", "status": "skipped",
    "reason": "held back: sending is limited to bardoli, this event is for Bahadurgarh" }
]}
```

`status` is **the ERP's vocabulary, not ours**: `sent`, `skipped`,
`failed`. `sent` is claimed only when a message really reached Meta —
our own `done` does not mean that, because `ping` and `customer.upsert`
succeed having sent nothing, and reporting those as sent would
re-create the confusion this exists to remove. `reason` is always
present.

This exists because a `200` used to mean "processed", which the ERP
reasonably read as "sent". An event the CRM deliberately skipped — a
branch held back by the gate, a store with no phone number, a branch
matching no CRM store, a template not yet approved — was
indistinguishable from a delivered message, and staff saw "sent"
against a bill nobody had been told about.

`failed` is unchanged and still drives the ERP's retries. `results` is
additive, so an ERP that does not read it yet is unaffected.

One known limit: a **replayed** event is answered from the ledger,
which does not store the message id, so a replayed `ping` or
`customer.upsert` reads as `sent`. Its `reason` still says what
happened. Storing the message id removes this, and is what the
per-event status endpoint needs anyway.

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

## Message activity — the screen staff read

`/message-activity` lists every automatic message and what became of
it, newest first, with a count per outcome so "3 failed today" is
visible without reading the list.

It exists because the answer was split in two and neither half was a
screen. `erp_events` knows WHY the CRM did or did not send — held
back by the gate, a store with no phone number, a branch matching no
store, a template not approved. `messages` knows what META did once
it was sent. The inbox shows the second half, one conversation at a
time, so "the customer says they got nothing" meant finding the
contact and scrolling, and nothing at all answered "what failed
today".

Migration 055 joins them: `erp_events.message_id` holds OUR
`messages.id` (not Meta's — migration 009 records that Meta's repeat
across phone numbers), and `erp_events.branch` stores the branch the
ERP named, because a contact can belong to several stores and
`contact_stores` therefore cannot say which shop a given message was
about.

**Who sees what is the database's decision.** The route reads as the
signed-in user, and migration 055's policy is the same boundary the
rest of the customer data uses: an owner or admin sees the whole
account, an agent sees only rows whose customer their store can
access (`can_access_contact`, migration 043). Rows with no contact —
`ping`, an unresolved customer, a branch that matched no store — stay
admin-only: they are deployment diagnostics, not one shop's business.

`ping` and `customer.upsert` are left off the list entirely. A
contact sync is not a message that failed to arrive.

The search box matches the **reason** and the **bill number**
(`erp_events.order_ref`, migration 056 — the bill no, else the ERP's
order id, the same key the review queue uses). Both are columns on
`erp_events`, so the database filters and the page limit still means
what it says.

**Delivered and Read fill in over time, and only for messages sent
after migration 055.** They come from Meta's status webhook, which
updates `messages` by Meta's own id a moment after the send; the
ledger row joins to that message through `message_id`. Rows written
before that column existed have none, so they can never show more
than "sent" — which is not a fault to fix but a history that was
never recorded.

## The send gate — running a trial on one branch

`ERP_SEND_ONLY_BRANCHES` limits which branches may actually send a
WhatsApp message. Comma-separated, matched with the same normalisation
as store lookup, so `Demo Store`, `demo-store` and `DEMO STORE` are
one branch.

Each entry must be **the branch name the ERP puts on the order**, not
a CRM store code: the gate compares against the event's own branch
string and never reads the stores table. Setting it to `BARD` for a
store the ERP calls `bardoli` silences that shop with no error
anywhere. The skip reason in the ledger quotes the ERP's branch name
verbatim — copy it from there.

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
the same store. A branch that matches nothing never fails the event: the
message still goes out, and the contact stays visible to owner/admin,
who can assign it by hand from the contact's Stores card.

Keep the store names/codes in Settings → Stores aligned with the ERP's
branch names. They do not have to match exactly, but they do have to
match after case and punctuation are stripped.

### When a branch matches no store

Every event records what the filing did, alongside what the send did:

```
sent order_confirmation | filed to Shastri Nagar
contact synced | branch matched no store: Demo Store
```

`/api/erp/status` collects the second kind into **`unmatchedBranches`**,
newest first, with a count of how many events each one has affected:

```json
"unmatchedBranches": [
  { "branch": "Demo Store", "events": 4, "lastSeen": "2026-10-07T…" }
]
```

An empty list is the healthy state. A non-empty one names a store to
create or rename, and the fix is a one-word edit in Settings → Stores —
after which new events file correctly. Earlier contacts stay unfiled
until the next event for them, or until an admin assigns them by hand.

This exists because the failure is otherwise invisible: the customer is
created, the message is delivered, nothing errors, and only the branch's
staff notice — by never seeing the customer at all. The scan covers the
last 500 ledger rows rather than the 50 shown under `events`, so one
busy, healthy branch cannot push a broken one out of view.

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
`owner`, `CompanyAdmin`, `manager`, `store`, `staff`), then **CRM
membership**.

The role list decides who may ATTEMPT a sign-in, not what they can
see. What a signed-in person reaches is decided entirely by the CRM
member their email matches — that member's `account_role` and
`store_id`, and `can_access_contact` (migration 043) underneath. An
ERP role of `store` therefore cannot read another branch's chats and
cannot conjure a member who does not already exist. That is why
`store` and `staff` could be added for the shop counters without
widening anything: each branch's till signs in as its own CRM member
and sees its own store.

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

## Inbox counts — "how many customers are waiting?"

`POST /api/erp/inbox-counts`, authenticated exactly like
`/api/erp/events`: `Authorization: Bearer <ERP_API_KEY>` plus
`X-ERP-Signature: sha256=<hex>` over the raw body.

```jsonc
// request — one branch
{ "branch": "Shastri Nagar" }
// request — the whole account (also: {} or no body at all)
{ "branch": null }

// response
{ "unread": 3, "awaitingReply": 5 }
```

| Field | Means |
|---|---|
| `unread` | conversations with an unopened incoming message |
| `awaitingReply` | conversations whose **last** message is the customer's — unless that message is only an acknowledgement ("ok", "thank you sir", 👍; see `src/lib/erp/acknowledgement.ts`). Needs migration 058; without it every such thread is still counted. |

The second number is the one worth showing a till. A thread staff
have opened and not answered is no longer bold in the inbox, so
`unread` drops to zero while the customer is still waiting — which is
exactly the conversation that gets forgotten.

The branch is matched the same way an event's branch is (name or
short code, through `normalizeStoreKey`). A branch matching no active
store is a **400** naming it and listing the stores that do exist, not
a 200 with zeros: a till reading "0 waiting" because two systems spell
a shop differently is a failure this integration has already had once,
with order messages.

A contact linked to two stores counts in both branches' numbers. That
is deliberate — both tills are genuinely waiting on that customer.

Needs migration **057**, which adds the `erp_inbox_counts` function.
Without it the endpoint answers 500 and says so.

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
