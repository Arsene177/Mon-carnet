---
name: Medical record integrity
description: User-stated rules for diagnoses, record immutability, and patient-granted access.
---

Medical records are immutable after creation. Preserve each record's free-text diagnosis, and attach structured disease codes only when creating a new record. Corrections or new information belong in a linked follow-up, not an edit to the original. Keep existing authentication and patient-granted doctor access checks in place.

**Why:** The user explicitly scoped Phase 1 to preserve the existing clinical history and access model.

**How to apply:** When changing record or diagnosis flows, append a follow-up instead of changing an existing record, and only allow code selection in the new-record flow.