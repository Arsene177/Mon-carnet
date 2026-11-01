---
name: Medical record integrity and access
description: User-stated rules for immutable clinical records, patient access, audit history, and record-type forms.
---

Medical records are immutable after creation. Preserve each record's free-text diagnosis, and attach structured disease codes only when creating a new record. Corrections or new information belong in a linked follow-up, not an edit to the original.

Doctors use a patient's ID and active patient-granted permission to open full history or add a record. Name lookup may show emergency information only. Patients choose the grant duration, may revoke access, and should be able to review who accessed records, at which hospital, and when. Record-entry fields should adapt to the selected record type; attached documents remain private to the patient and authorized clinicians. Uploaded lab reports remain pending for seven days and can be retried after a record-save interruption; link them to the immutable record atomically.

**Why:** The user explicitly specified these access boundaries, patient controls, audit details, record-type-specific entry behavior, and preserving lab reports when record saving is interrupted.

**How to apply:** When changing record or diagnosis flows, append a follow-up instead of changing an existing record; preserve emergency-only name lookup, ID-based full-record access, patient-selected expiry, hospital-stamped access history, and retryable private lab uploads.