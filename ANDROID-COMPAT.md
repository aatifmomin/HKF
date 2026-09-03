# Android ↔ Web data contract

The web app is aligned field-by-field with the Android build in
`scratch 8.zip`, verified against the production RTDB export. Every shape
below was checked against real data, not inferred from the Kotlin alone.

## Latest round (scratch 8) — collector payments, announcements, year data

Three new nodes and five new `/settings` keys. This is the biggest change
since the join queue, because it puts a name on money that used to move
invisibly.

### `/collectors/{uid}` — an admin's collection profile

Keyed by the admin's **auth uid**, not by email (unlike `/admins`, which is
keyed by push id and carries the email). Both clients only ever write their
own uid.

| Field | Type | Notes |
|---|---|---|
| `displayName` | string | Snapshotted from the account at save time. |
| `email` | string | The join between this node and `/admins`, which has no uid. |
| `upiId` | string | Enables tap-to-pay. Optional if a QR is set. |
| `qrBase64` | string | **Bare base64 JPEG**, no `data:` prefix — same convention as every other blob in this database. Compressed to ≤ 200 KB on both clients. |
| `active` | bool | Off hides them from members while away. **Absent means active** — Kotlin's default is `true`, so the web treats a missing key as `true` too, not `false`. |
| `updatedAtMillis` | long | Client clock. |

Two derived properties both clients compute the same way, never stored:

```
hasQr      = qrBase64 is not blank
canReceive = active && (hasQr || upiId is not blank)
label      = displayName, or the part of email before "@"
```

Only collectors with `canReceive` appear in the member's pay list.

### `/collectorTransfers/{pushKey}` — money moved to the foundation

| Field | Type | Notes |
|---|---|---|
| `collectorUid` | string | Required — a row without it is skipped by both clients. |
| `collectorName` | string | Snapshotted. |
| `amountMinor` | long | Paise. |
| `note` | string | UTR / reference, optional. |
| `transferredAtMillis` | long | When the money moved. Sort key. |
| `status` | string | `"confirmed"` on create — see below. |
| `confirmedByEmail` | string | Written only by the (unused) owner-confirm path. |
| `confirmedAtMillis` | long | Stamped on create. |
| `createdAtMillis` | long | Stamped on create. |

**`status` is written `"confirmed"` immediately, not `"pending"`.** The data
class defaults to `pending` and there is a `confirmTransfer` path for the
owner, but `recordTransfer` — the only way either client actually creates a
row — writes `confirmed` outright. The admin's own record is treated as the
truth; a mistyped amount is deleted, not disputed. The web does exactly the
same, so a transfer recorded on the phone and one recorded on the web are
indistinguishable.

### Nothing is counted — every figure is derived

There is no collector counter to drift between clients. Both compute, in one
round of reads over `/payments`, `/paymentRequests` and the transfer ledger:

```
received    = sum of approved payments carrying this collectorUid
pending     = sum of still-pending requests naming this collector
denied      = count of denied requests naming this collector
transferred = sum of CONFIRMED transfers by this collector
balance     = received - transferred      // still in their own account
```

### `collectorUid` / `collectorName` on requests and payments

Both `/paymentRequests/{key}` and `/payments/{uid}/{key}` gained the pair.
Blank means "unknown / legacy", and `"hkf_direct"` is the sentinel for the
foundation's own bank account (label: `HKF bank account (direct)`).

Approval copies the pair from the request onto **every** payment row it
writes, including each row of a multi-month split. That copy is what makes
`received` add up.

**The decision gate.** A pending request may be approved or denied only by:

- the admin whose uid is in `collectorUid`, or
- the owner, or
- anyone, when `collectorUid` is blank or `hkf_direct`

Nobody else can vouch for cash landing in someone else's account. Other
admins still see the card; where the buttons would be they read *"Awaiting
&lt;name&gt; — only they (or the owner) can confirm this money arrived."* This
is UI-level on both clients — the rules can't express it — so it is a
workflow guard, not a security boundary.

**Removing an admin is blocked while they hold money.** Both clients check
`balance > 0` for the matching collector profile before removing an admin,
and refuse with the outstanding amount named. Matched by **email**, because
`/admins` has no uid.

### `/announcements/{pushKey}`

| Field | Type | Notes |
|---|---|---|
| `title` | string | Required. A row with no title is skipped by both clients. |
| `description` | string | Free text. |
| `imageBase64` | string | Bare base64 JPEG, ≤ 200 KB, or empty. |
| `postedByName` | string | Falls back to the part of the email before `@`. |
| `postedByEmail` | string | Written but not read back — the data class omits it. |
| `postedAtMillis` | long | Sort key, newest first. |

**One active announcement at a time.** `post()` reads the node first and
refuses if anything is there: *"Only one announcement is allowed — delete the
current one first."* Both clients enforce it, so the bell always means exactly
one thing.

**The unread dot is per-device, not per-account.** Android keeps the marker in
SharedPreferences, the web in `localStorage`. Neither writes it to the
database, so reading on your phone does not clear the dot on the web. That is
Android's design and the web matches it deliberately.

### New `/settings` keys

| Key | Type | Notes |
|---|---|---|
| `websiteLink` | string | Public site. Goes out in the share **text** alongside the app link. |
| `bankDetails` | string | Free text, newlines preserved. Shown with tap-to-copy under "pay HKF directly". |
| `appLatestVersion` | string | e.g. `"1.2"`. Compared segment-wise and numerically on Android, so `1.10 > 1.2`. |
| `appUpdateNotes` | string | What's new. |
| `appUpdateEnabled` | bool | Master switch for the update card. |

Note `/settings` is now **owner-write-only** server-side in your rules. Both
clients already gate Settings behind the owner email, so nothing changes in
practice — but it does mean a plain admin cannot write any of these.

### Year backup / restore / reset

`YearDataManager` on Android, `year-data.js` on the web. The backup file is
byte-identical, so a backup taken on the phone restores from the web and back:

```json
{ "app": "HKF", "format": 1, "year": 2026, "exportedAtMillis": 0,
  "counts": { ... },
  "records": { "payments/{uid}/{key}": { ... }, "paymentRequests/{key}": { ... } } }
```

Year attribution: payments and requests by the year of `coversMonthKey` (a
multi-month request belongs to the year its **first** month is in); proofs
follow their request; handovers by `applicationDateMillis`, falling back to
`createdAtMillis`; transfers by `transferredAtMillis`. Members, admins,
settings, collector profiles, announcements and tech support are **not** year
data and are never touched.

Every write is a fan-out path update chunked at 40, so only the selected
year's rows move.

**Reset is deliberately wider than backup** — this is the owner's own
definition on Android, and it surprises people:

1. payments of the chosen **year only**
2. **ALL** handovers with their documents (numbering restarts at H-001)
3. **ALL** activity — every payment request with every proof, and every join
   request, decided ones included

Both clients then recompute every member's `totalPaidMinor` from the payments
that survive. Without that pass the member cards, the export and Android's
widget keep showing pre-reset figures, because fan-out writes bypass the
per-write total upkeep.

The web refuses any backup path outside `payments/`, `paymentRequests/`,
`paymentProofs/`, `handovers/`, `handoverDocs/` and `collectorTransfers/`, and
any path containing `..` — a picked file is the one place in either app where
user input becomes database paths.

### Smaller things in the same round

- The share card no longer **draws** the download link. A link baked into a
  PNG can't be tapped and goes stale; it travels in the share text instead,
  now with the website link under it.
- The member's request date picker no longer caps at today — paying for
  upcoming months in advance is the point of the months stepper.
- Support wording: "+ New issue" → "+ Suggestion" throughout.
- Admins reach Tech Support and My Collections from cards on Home, because
  the nav bar is full at five tabs. Same reason on both clients.
- A red dot on the Activity tab when something pending is newer than the last
  time that device opened it. Per-device, like the bell.
- Every repository that could previously close its listener with an exception
  now logs and emits empty instead. A missing rule should not take a screen
  down.

## Previous round (scratch 5) — Tech Support

Android added a support-ticket system: members file issues from a new
**Support** tab, the owner works them from a queue inside Settings. Two new
RTDB nodes, both now written identically by the web.

### `/techSupport/{pushKey}`

| Field | Type | Notes |
|---|---|---|
| `ticketId` | string | Human-facing id, `T-001` — zero-padded to 3, keeps growing past 999. |
| `memberUid` | string | Filer's auth uid. The member list is a query on this, so it needs an index. |
| `memberName` | string | Display name at filing time, snapshotted (not re-read later). |
| `memberEmail` | string | Same. |
| `title` | string | Required — an empty title is not filed. |
| `description` | string | Optional, free text. |
| `status` | string | `"OPEN"` or `"RESOLVED"` — exact casing, compared as a string on both sides. |
| `createdAtMillis` | long | Client clock, `Date.now()`. Sorting key everywhere. |
| `resolvedAtMillis` | long | `0` until resolved. |
| `resolvedByName` | string | Owner's display name, falling back to the part of their email before `@` — Android stores a name, never an email. |
| `resolutionNote` | string | Optional note the owner leaves when resolving. |
| `reopenNote` | string | Optional note the member leaves when reopening. |
| `reopenedAtMillis` | long | `0` until reopened. |

Every field is always written on create, including the empty ones. Android's
`TechSupportTicket` is a Kotlin data class with non-null defaults; a missing
key deserializes fine, but writing them all keeps the two clients' rows
byte-comparable in the console.

**Reopen keeps the resolution.** Reopening sets `status` back to `OPEN` and
stamps `reopenNote` / `reopenedAtMillis`, but leaves `resolvedAtMillis`,
`resolvedByName` and `resolutionNote` in place, so both clients can still show
"resolved by X, then reopened". Resolving again overwrites the resolution
fields and the reopen note stays as history.

### `/techSupportCounter`

A **bare number**, same shape as `handoversCounter` — not an object. `T-004`
means the counter reads 4.

Android reads it, adds one, writes it back. The web uses `runTransaction`
instead, so two members filing at the same moment can't be handed the same
ticket id. The stored value is identical either way; this is a concurrency
fix, not a schema change, and it is safe to mix clients.

### Where it appears

- **Member**: a fourth tab, **Support**, next to Home / Payments / Profile.
  Lists only that member's tickets (`orderByChild("memberUid").equalTo(uid)`),
  newest first, with a search box and open/resolved counts.
- **Owner**: Settings → **TECH SUPPORT** opens the full queue — every ticket
  from every member, **open first, newest-first within each group**. Resolve,
  delete, and the filer's name/date on each card.
- Only the owner (`/owner_email`) sees the queue; ordinary admins do not.

### Earlier: scratch 4

New or changed contracts, all now mirrored:

| Contract | Detail |
|---|---|
| `paymentRequests.coversMonthCount` | int 1–12, absent ⇒ 1. One request can cover several consecutive months. |
| `paymentRequests.discussionMessageKey` | **removed** — no longer written by either client. Existing values are dead data. |
| `approvedPaymentKey` | now a **comma-joined list** of payment keys, one per covered month. A single-month approval still stores one bare key, so old rows keep working. |
| `settings.updateContactText` | string — the nudge shown to members with no contact number. |
| `settings.upiId` / `settings.upiName` | strings — power the member's tap-to-pay button. |
| `settings.paymentQr` | `{ name, base64 }` — the QR members scan. Read on demand only; the live settings listener checks `paymentQr/name` and nothing else. |
| member self-edit | a member may write their own `contactNumber`, `currentAddress`, `permanentAddress`, `occupation` and nothing else. |
| remove member | cascades in one atomic write: `members/{k}`, `payments/{k}`, `joinRequests/{k}`, plus `paymentRequests/{r}` + `paymentProofs/{r}` for every request that member filed. |
| danger zone | three separate wipes — members (+payments +counter), handovers (+docs +counter), activity (requests +proofs +joins). |
| year picker | dynamic: base 2026–2030 plus any year seen in a `coversMonthKey` (1990–2099). |

### The multi-month split, exactly

The amount on a request is the **total across all covered months**. Approval
writes one `/payments` row per month:

```
monthCount = clamp(coversMonthCount, 1, 12)
monthKeys  = N consecutive months from coversMonthKey   // walks the calendar
perMonth   = floor(total / monthCount)
remainder  = total - perMonth * monthCount              // 0 .. monthCount-1
row[i].amountMinor = perMonth + (i === 0 ? remainder : 0)
row[i].note        = monthCount === 1
                       ? "Approved request"
                       : `Approved request (${i+1}/${monthCount})`
```

The remainder goes entirely on the **first** month, so the rows always add back
up to the total exactly. ₹1,000 over 3 months → 33334 / 33333 / 33333 paise.
`batchKey` is each row's own push key (Android does the same — the rows of one
approval are deliberately *not* grouped as a batch).

Reverting deletes every key in `approvedPaymentKey`. The legacy fuzzy match
(note + month + amount) only ever matches a single-month approval, which is
correct: multi-month approvals always carry the key list.

**Known Android bug, not mirrored:** `WidgetActionReceiver` rebuilds the
request without `coversMonthCount`, so approving a multi-month request *from
the home-screen widget* writes one row for the full total instead of the split.
Approving from the Activity tab is correct. Worth fixing on the Android side.

## What was actually wrong

Nine contracts disagreed. In every case Android was treated as correct and the
web was changed to match.

| # | Contract | Web was writing | Android expects (and now web writes) |
|---|---|---|---|
| 1 | Handover doc blob | `{name, mime, sizeBytes, data:"data:image/jpeg;base64,…", uploadedBy…}` | `{name, type:"jpg", base64:"/9j/…"}` |
| 2 | Handover doc index | `{name, mime, sizeBytes}` | `{name, type, sizeBytes, uploadedAtMillis, uploadedByEmail}` |
| 3 | Payment proof key | `/paymentProofs/{newPushId}`, request carried `proofId` | `/paymentProofs/{requestKey}`, request carries **`proofName` only** |
| 4 | Payment proof blob | `{name, mime, sizeBytes, data, uploadedBy…}` | `{name, type, base64}` |
| 5 | Approved-payment link | `paymentKey` | `approvedPaymentKey` |
| 6 | Payment row | included a `dateMillis` field | `{coversMonthKey, amountMinor, category, note, batchKey, recordedByEmail, recordedAtMillis}` — no `dateMillis` |
| 7 | Join request | `{uid, emailLower, photoUrl, createdAtMillis, status:"declined"}` | `{email, displayName, requestedAtMillis, status:"denied", decidedBy…}` |
| 8 | Pre-registered member | `push()` key + `pending:true` field | key prefixed **`pending_`**, no flag field |
| 9 | Member record | added a `fullName` field | no such field — `displayName` is the name |

Two of these were destructive rather than merely incompatible:

**`handoversCounter` would have broken Android's numbering.** The web wrote
`handoversCounter/value` (an object); Android reads the node itself as a
`Long` (`snapshot.value as? Long`). The first handover created on the web
would have replaced the scalar `4` with `{value: 1}`, after which every
Android attempt to allocate an application number reads null → starts again at
`H001` → duplicate numbers. Fixed: the counter is a bare number and the format
is `H%03d` ("H005"), continuing production's existing H001–H004.

**`totalPaidMinor` drift.** The web incremented it; Android always recomputes
it as the sum of `/payments/{uid}/*`. Mixed use means a payment deleted on
Android leaves the web's running total permanently high. The web now
recomputes too, everywhere.

The stray row this left in production — `/paymentProofs/-OzziQZyZjuD6RPq2y1V`
in the old `{data, mime, …}` shape — still opens: the reader is deliberately
lenient (see below).

## The contract

`base64` is **bare** — no `data:image/jpeg;base64,` prefix. That is what
`Base64.encodeToString(bytes, NO_WRAP)` emits and what
`Base64.decode(s, DEFAULT)` expects. `type` is a **file extension**
(`"jpg"` / `"pdf"`), not a mime type; feeding it to a browser `Blob`
constructor unchanged produces a file the OS refuses to open, which is worth
knowing if you touch `attachments.js`.

```
/handovers/{key}/documents/{docId} = { name, type, sizeBytes,
                                       uploadedAtMillis, uploadedByEmail }
/handoverDocs/{key}/{docId}        = { name, type, base64 }

/paymentRequests/{key}  = { memberUid, memberId, memberName, memberEmail,
                            amountMinor,          // TOTAL across all months
                            requestedDateMillis, coversMonthKey,
                            coversMonthCount,     // 1-12, absent => 1
                            category, status, createdAtMillis,
                            decidedByEmail, decidedByName, decidedAtMillis,
                            approvedPaymentKey,   // comma-joined key list
                            proofName }           // "" = no proof
/paymentProofs/{key}               = { name, type, base64 }   // key = REQUEST key
/members/{uid}          = { memberId, displayName, email, role, joinedAtMillis,
                            totalPaidMinor, contactNumber, currentAddress,
                            permanentAddress, occupation }
/members/pending_{k}    = same shape, for someone who hasn't signed in yet
/payments/{uid}/{key}   = { coversMonthKey, amountMinor, category, note,
                            batchKey, recordedByEmail, recordedAtMillis }
/joinRequests/{uid}     = { email, displayName, requestedAtMillis, status,
                            decidedByEmail, decidedByName, decidedAtMillis }
/settings               = { apkLink, reminderDay, reminderText,
                            updateContactText, upiId, upiName,
                            paymentQr: { name, base64 } }
/reminderLog            = { monthKey, byName, byEmail, atMillis }
/handoversCounter       = 4          // bare number
/membersCounter         = 14         // bare number
```

Index and blob are written in **one multi-path `update()`**, so a failure
can't leave a card row pointing at nothing — same as Android.

Reading is lenient on purpose. `normalizeAttachment()` accepts
`base64`/`data`/`dataBase64`/`content`, `type`/`mime`/`mimeType`,
`name`/`fileName`, bare and data-URL encodings, `Base64.DEFAULT`'s embedded
newlines, URL-safe alphabets and missing padding, and sniffs the type from
magic bytes when nothing declares one. Writing picks exactly one shape;
reading forgives everything already in the database.

## Ported to web in this build

- **Reminder tab** (admin). Unpaid = no `/payments/{uid}/*` row whose
  `coversMonthKey` equals the current device-local month. Amount and category
  are irrelevant; `pending_` rows are included; the year picker does not apply.
  `sms:` links, and `/reminderLog` records who sent the round (it self-expires
  when the month rolls over).
- **Settings** (owner), behind the gear on Home: `apkLink`, `reminderDay`
  (1–28, blank = off), `reminderText`, Manage admins, and the danger-zone
  wipe of `/paymentRequests` + `/joinRequests` + `/paymentProofs`.
- **Member reminder banner** on Payments, from `reminderDay` onward, for
  members who haven't paid the current month.
- **Activity**: owner `✕` delete on request and join cards, "Move to pending"
  on paid handovers, transaction-guarded status claims so two admins tapping
  Approve can't both record the payment.
- **Nav** now matches Android: Home / Members / Handover / Activity /
  Reminder. The Admins tab is gone — it lives inside Settings.
- **Share card** prints `/settings/apkLink`, and the share text is Android's
  wording verbatim, so a forwarded message reads the same from either app.

## Deliberate differences

`AuthViewModel.resolveMembership()` calls `joinRequestRepository.submit()`
unconditionally, and `submit()` rewrites a **denied** row back to pending. On
Android that means a declined person silently rejoins the queue every time
they open the app: the "Request declined" screen is unreachable, and an
admin's Discard is undone on the next launch, so the same request keeps
reappearing in Activity.

The web only submits when there is no row at all, and lets the person re-apply
deliberately with "Request again". Same data shape either way — this is
behaviour, not schema — but it is worth fixing on Android too: in
`resolveMembership`, read the row first and only call `submit()` when it is
absent.

**2. The owner is not locked out by their own "Delete all members".**

That wipe takes the owner's member row with it. Android resolves membership
once at sign-in, so it doesn't notice until the next launch (when the
owner/admin branch quietly recreates the row). The web holds a live listener,
so without special handling the owner would be dumped onto the "Pending
approval" screen inside their own foundation, mid-session. The web recreates
the row immediately instead — the same thing the next sign-in would do.

**3. The Settings helper text for the QR says "Home", not "Payments".**

Android's string claims members see the QR on their Payments tab; the card
actually renders on Home in both clients. The web copy describes where it
really is.

**4. The app-update card is not version-gated on the web, and says so.**

Android compares `appLatestVersion` with the version installed on that phone
and shows the card only when there is genuinely something newer. A browser has
no installed version — it always runs whatever was last deployed — so there is
nothing to compare against. The web shows the card whenever the owner switches
it on, and words it as an **Android app** update, which is what the APK link
actually is, plus a line saying the website is always current.

**5. The announcements bell lives in the shared top bar, not on Home.**

Android hangs it off the Home screen beside the year picker. The web's top bar
is shared by every tab, so the bell sits there and is reachable from anywhere.
Same node, same one-at-a-time rule, same per-device unread marker — strictly
more reachable, not different.

**6. Ticket ids and nothing else use a transaction.**

Carried over from the last round and still true: Android allocates a ticket id
read-then-write, the web uses `runTransaction`, so two members filing in the
same second can't collide. Same stored value; a concurrency fix, not a schema
change.

## Rules

`database.rules.json` is now the rule set **you** sent on 2 Sep, with the
nodes already in it — `/settings`, `/reminderLog`, `/techSupport`,
`/techSupportCounter`, `/announcements`, `/collectors`, `/collectorTransfers`.
That was the blocker in the last three rounds and it is gone. Publishing is no
longer the thing standing between you and a working Settings screen.

The only edits are three `.indexOn` lines:

| Node | Index | Why |
|---|---|---|
| `/techSupport` | `memberUid`, `status`, `createdAtMillis` | The member's own ticket list is a real server query (`orderByChild("memberUid").equalTo(uid)`). Without the index Firebase downloads the whole node and sorts it on the device. |
| `/collectorTransfers` | `collectorUid`, `transferredAtMillis` | For when the ledger outgrows a single read. |
| `/announcements` | `postedAtMillis` | Cheap, and the sheet is sorted by it. |

A missing index is a warning in the console, never a permission error, so
nothing breaks if you skip them.

One node in your rules is worth tightening when you next touch them:

```
"collectors": {
  ".read": "auth != null",
  "$uid": { ".write": "auth != null && auth.uid == $uid" }
}
```

As written, any signed-in account can overwrite any admin's collection QR.
Neither client ever writes another admin's profile, so this is theoretical
rather than live — but it is the one place here where a tighter rule costs
nothing at all. `/collectorTransfers` cannot take the same treatment: admins
record their own transfers and delete their own mistakes, so it has to stay
open. The owner's view in My Collections is what makes it accountable.

Worth knowing: only `/admins` is genuinely enforced (owner email, checked
server-side). Everywhere else any signed-in account can write, so a signed-in
non-member could in principle write `/members/{their uid}` and skip the queue.
Rules have no queries, so "is this email in /admins" is not expressible —
`/admins` is keyed by push id and cannot be scanned. The cheap check that
*would* help is `root.child('members').child(auth.uid).exists()` on
`/handovers`, `/paymentRequests` and `/paymentProofs`; only approved members
ever write those in either client. `/members` itself can't take that check —
Android's `ensureMemberExists` and the `pending_` claim both write it for
someone who is not yet a member.
