---
name: Medical record integrity and access
description: User-stated rules for immutable clinical records, patient access, audit history, and record-type forms.
---

Medical records are immutable after creation. Preserve each record's free-text diagnosis, and attach structured disease codes only when creating a new record. Corrections or new information belong in a linked follow-up, not an edit to the original.

Doctors use a patient's ID and active patient-granted permission to open full history or add a record. Name lookup may show emergency information only. Patients choose the grant duration, may revoke access, and should be able to review who accessed records, at which hospital, and when. Record-entry fields should adapt to the selected record type; attached documents remain private to the patient and authorized clinicians.

**Why:** The user explicitly specified these access boundaries, patient controls, audit details, and record-type-specific entry behavior.

**How to apply:** When changing record or diagnosis flows, append a follow-up instead of changing an existing record; preserve emergency-only name lookup, ID-based full-record access, patient-selected expiry, and hospital-stamped access history.