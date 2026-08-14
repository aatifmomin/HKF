# Android ↔ Web compatibility

Findings from reading the Android source (`scratch.zip`, package
`com.hasnainkarimain.foundation`) against this web build.

## Why attachments don't cross over

**The Android app has no attachment feature.** There is nothing to be
incompatible with — it is not a format mismatch, an encoding difference, or a
rules problem.

Evidence, from a full-tree search of `app/src/main/java`:

| Looked for | Result |
|---|---|
| `handoverDocs` | 0 references |
| `paymentProofs` | 0 references |
| `Base64` (file encoding) | 0 references |
| `documents` field on handovers | not in `HandoverApplication` or `HandoverRecord` |
| `proofId` / proof fields | not in `PaymentRequest` or `PaymentRequestRecord` |

The RTDB paths Android touches are exactly: `admins`, `members`,
`membersCounter`, `payments`, `paymentRequests`, `handovers`,
`handoversCounter`, `messages`, `presence`, `notifications`, `.info/connected`.

So: a document uploaded on the web is stored correctly and is readable — the
Android app just has no code that looks for it. And Android can't originate one.

Your security rules are fine. Both `/handoverDocs` and `/paymentProofs` are
`auth != null` for read and write, so neither client is being denied.

## Good news: nothing is being corrupted

Two things that could have gone badly, checked and cleared:

- **Unknown fields don't crash Android.** The web writes fields Android's data
  classes don't declare (`documents`, `proofId`, `fullName`, `claimedFromKey`,
  …). Firebase's `CustomClassMapper` only *throws* on unknown properties when a
  class carries `@ThrowOnExtraProperties`; there are none in the codebase. It
  logs a warning to logcat and moves on. If the logcat noise bothers you, add
  `@IgnoreExtraProperties` to `HandoverRecord`, `MemberRecord` and
  `PaymentRequestRecord`.
- **Android edits don't wipe web data.** `updateHandover` and the member edit
  path both use `updateChildren` (a merge), not `setValue` (a replace). The only
  `setValue` calls on a whole node are at creation time. So editing a handover
  on Android will not delete its `documents` index.

## Wire format for the Android implementation

`data` is **bare base64** — no `data:image/jpeg;base64,` prefix. That is
`Base64.encodeToString(bytes, Base64.NO_WRAP)` in, `Base64.decode(s,
Base64.DEFAULT)` out, with no string surgery on either side. The web strips the
prefix its `FileReader` produces before writing.

```
/handovers/{key}/documents/{docId} = {     // index only — no blob here
  name:      String,      // "receipt.jpg"
  mime:      String,      // "image/jpeg" | "image/png" | "application/pdf"
  sizeBytes: Long
}

/handoverDocs/{key}/{docId} = {            // the blob
  name, mime, sizeBytes,
  data:             String,   // bare base64
  uploadedByEmail:  String,
  uploadedAtMillis: Long
}

/paymentRequests/{key}.proofId = "<proofId>"     // index
/payments/{uid}/{key}.proofId  = "<proofId>"     // same id — the blob is shared,
                                                 // not copied, on approval
/paymentProofs/{proofId} = {
  name, mime, sizeBytes, data,
  uploadedByUid, uploadedByEmail, uploadedAtMillis
}
```

**The index/blob split is load-bearing.** The handover list and the Activity
feed hold `ValueEventListener`s on `/handovers` and `/paymentRequests`. If the
base64 lived inline, every listener would re-download every megabyte on every
unrelated change. Write the blob to its own top-level node and keep only
`name`/`mime`/`sizeBytes` on the parent. Fetch blobs one key at a time, on tap.

Matching Kotlin:

```kotlin
data class HandoverDocIndex(
    val name: String = "",
    val mime: String = "",
    val sizeBytes: Long = 0L
)

data class HandoverDocBlob(
    val name: String = "",
    val mime: String = "",
    val sizeBytes: Long = 0L,
    val data: String = "",              // bare base64
    val uploadedByEmail: String = "",
    val uploadedAtMillis: Long = 0L
)

// write
val docId = database.getReference("handoverDocs").child(key).push().key!!
val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
database.getReference("handoverDocs/$key/$docId")
    .setValue(HandoverDocBlob(name, mime, bytes.size.toLong(), b64, email, System.currentTimeMillis()))
database.getReference("handovers/$key/documents/$docId")
    .setValue(HandoverDocIndex(name, mime, bytes.size.toLong()))

// read
val bytes = Base64.decode(blob.data, Base64.DEFAULT)
```

Delete the index child first, then the blob — an orphan blob is invisible and
harmless, a dangling index row is a broken button.

The web reader is deliberately lenient (`normalizeAttachment` in
`attachments.js`): it accepts `data` / `base64` / `dataBase64` / `content`,
`mime` / `mimeType` / `contentType`, `name` / `fileName` / `filename`, both bare
and data-URL encodings, `Base64.DEFAULT`'s embedded newlines, URL-safe base64,
and missing padding. It sniffs the type from magic bytes when no mime is stored.
So if the Android naming drifts slightly, the web will still open the file — but
please match the shape above so it goes the other way too.

## Other gaps in the same Android snapshot

The build you sent predates most of the feature list. Worth knowing, roughly in
order of how much it matters:

1. **Join approval is bypassed on Android.** There is no `joinRequests` anywhere
   in the Android source, and `MembersRepository.ensureMemberExists()` still
   auto-creates `/members/{uid}` on first sign-in. Anyone who signs in through
   the Android app therefore walks straight into the foundation with no
   approval, and the web's queue never sees them. **This defeats the join gate
   entirely** — worth fixing before the attachments.
2. **Member profile fields are invisible on Android.** `MemberRecord` has only
   `memberId`, `displayName`, `email`, `role`, `joinedAtMillis`,
   `totalPaidMinor`. No `fullName`, `contactNumber`, `currentAddress`,
   `permanentAddress`, `occupation`. Android won't display or capture them. It
   won't erase them either (see above).
3. **Discussion still exists on Android** — `messages` and `presence` are live
   there, and the web has removed both. Members using the two clients see
   different apps.
4. **`paymentRequests.paymentKey` is web-only.** The web stamps it on approval so
   the owner's Approved→Denied revoke can delete exactly the right payment row.
   For requests approved on Android the web falls back to matching on
   month + amount + `note == "Approved request"`, which works but is a
   heuristic. Writing `paymentKey` on the Android approve path removes the guess.
5. `joinRequests` in your rules is indexed on `requestedAtMillis`, but the web
   writes `createdAtMillis`. Harmless today (nothing queries by it), but the
   index won't do anything until the names agree.

The hand-rolled XLSX writer is present and matches — that one is fine.
