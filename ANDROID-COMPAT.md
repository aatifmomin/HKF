# Android ↔ Web data contract

The web app is aligned field-by-field with the Android build in
`scratch 4.zip`, verified against the production RTDB export. Every shape
below was checked against real data, not inferred from the Kotlin alone.

## Latest round (scratch 4)

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

## Rules

`database.rules.json` is your rule set with two nodes added: **`/settings` and
`/reminderLog` were missing**, and an unlisted path in Realtime Database is
denied. Until you publish it, Settings → Save silently fails on both clients,
the share card can't read `apkLink`, and "Reminder given by …" never appears.
The `joinRequests` index also named `requestedAtMillis` — which is correct and
now matches what both clients write.

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
