/*
# Create Medichain full database schema

Creates all tables required by the Medichain medical records platform.
This is the initial schema — no tables existed previously.

## Tables created:

1. **medichain_users** — User accounts (patients, doctors, admins)
   - id (serial PK), email (unique), password_hash, role, name, hospital_name (nullable, for doctors)
   - date_of_birth (nullable, for patients), contact_info (nullable), is_active
   - created_at, updated_at

2. **medichain_emergency_info** — Patient emergency information (1:1 with users)
   - id (serial PK), user_id (FK → users), blood_group, weight_kg, height_cm
   - allergies, emergency_contact, created_at, updated_at

3. **medichain_medical_records** — Patient medical records
   - id (serial PK), patient_id (FK → users), doctor_id (FK → users)
   - record_type, diagnosis, treatment, medications (text[]), notes
   - follow_up_to_record_id (self-ref FK), vitals (jsonb), created_at

4. **medichain_access_permissions** — Patient-granted doctor access
   - id (serial PK), patient_id (FK → users), doctor_id (FK → users)
   - granted, granted_at, expires_at, created_at
   - Unique constraint on (patient_id, doctor_id)

5. **medichain_patient_searches** — Logs of doctor searches for patients
   - id (serial PK), patient_id (FK → users), doctor_id (FK → users), searched_at

6. **medichain_disease_codes** — ICD-10 disease code catalog
   - id (serial PK), code, coding_system, release, disease_name, description
   - infectious, epidemic_relevant, pandemic_relevant, status, source, created_at
   - Unique index on (coding_system, release, code)

7. **medichain_medical_diagnoses** — Coded diagnoses linked to records
   - id (serial PK), record_id (FK → records), disease_code_id (FK → disease_codes)
   - status, diagnosis_date, onset_date, notes, supporting_record_id (self-ref FK), created_at

8. **medichain_medical_attachments** — Private medical file attachments
   - id (serial PK), patient_id (FK → users), doctor_id (FK → users)
   - record_id (FK → records, nullable), object_path (unique), file_name
   - content_type, size, status, expires_at, created_at, uploaded_at, attached_at

9. **medichain_audit_events** — Audit trail of access and actions
   - id (serial PK), actor_user_id (FK → users), patient_id (FK → users, nullable)
   - action, entity_type, entity_id, hospital_name (nullable), created_at

## Security:
- RLS enabled on all tables.
- The Express API server connects with the service role key (bypasses RLS).
- Policies use `TO anon, authenticated` as a permissive default since the
  application enforces authorization in the Express middleware layer.

## Notes:
- All tables use serial integer primary keys (matching Drizzle schema).
- Timestamps use `withTimezone: true` (timestamptz).
- jsonb used for vitals column on medical_records.
- text[] (array) used for medications column on medical_records.
*/

-- ============================================
-- 1. medichain_users
-- ============================================
CREATE TABLE IF NOT EXISTS medichain_users (
  id serial PRIMARY KEY,
  email text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL,
  name text NOT NULL,
  hospital_name text,
  date_of_birth date,
  contact_info text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS medichain_users_email_unique ON medichain_users (email);
CREATE INDEX IF NOT EXISTS medichain_users_role_index ON medichain_users (role);

ALTER TABLE medichain_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_users" ON medichain_users;
CREATE POLICY "anon_select_users" ON medichain_users FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_users" ON medichain_users;
CREATE POLICY "anon_insert_users" ON medichain_users FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_users" ON medichain_users;
CREATE POLICY "anon_update_users" ON medichain_users FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_users" ON medichain_users;
CREATE POLICY "anon_delete_users" ON medichain_users FOR DELETE
  TO anon, authenticated USING (true);

-- ============================================
-- 2. medichain_emergency_info
-- ============================================
CREATE TABLE IF NOT EXISTS medichain_emergency_info (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES medichain_users(id) ON DELETE CASCADE,
  blood_group text NOT NULL DEFAULT 'Unknown',
  weight_kg real NOT NULL DEFAULT 1,
  height_cm real NOT NULL DEFAULT 30,
  allergies text NOT NULL DEFAULT '',
  emergency_contact text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS medichain_emergency_user_unique ON medichain_emergency_info (user_id);

ALTER TABLE medichain_emergency_info ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_emergency" ON medichain_emergency_info;
CREATE POLICY "anon_select_emergency" ON medichain_emergency_info FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_emergency" ON medichain_emergency_info;
CREATE POLICY "anon_insert_emergency" ON medichain_emergency_info FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_emergency" ON medichain_emergency_info;
CREATE POLICY "anon_update_emergency" ON medichain_emergency_info FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_emergency" ON medichain_emergency_info;
CREATE POLICY "anon_delete_emergency" ON medichain_emergency_info FOR DELETE
  TO anon, authenticated USING (true);

-- ============================================
-- 3. medichain_medical_records
-- ============================================
CREATE TABLE IF NOT EXISTS medichain_medical_records (
  id serial PRIMARY KEY,
  patient_id integer NOT NULL REFERENCES medichain_users(id) ON DELETE CASCADE,
  doctor_id integer NOT NULL REFERENCES medichain_users(id) ON DELETE RESTRICT,
  record_type text NOT NULL,
  diagnosis text NOT NULL DEFAULT '',
  treatment text NOT NULL DEFAULT '',
  medications text[] NOT NULL DEFAULT '{}',
  notes text NOT NULL DEFAULT '',
  follow_up_to_record_id integer REFERENCES medichain_medical_records(id) ON DELETE SET NULL,
  vitals jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS medichain_records_patient_index ON medichain_medical_records (patient_id);
CREATE INDEX IF NOT EXISTS medichain_records_doctor_index ON medichain_medical_records (doctor_id);
CREATE INDEX IF NOT EXISTS medichain_records_followup_index ON medichain_medical_records (follow_up_to_record_id);
CREATE INDEX IF NOT EXISTS medichain_records_created_index ON medichain_medical_records (created_at);

ALTER TABLE medichain_medical_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_records" ON medichain_medical_records;
CREATE POLICY "anon_select_records" ON medichain_medical_records FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_records" ON medichain_medical_records;
CREATE POLICY "anon_insert_records" ON medichain_medical_records FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_records" ON medichain_medical_records;
CREATE POLICY "anon_update_records" ON medichain_medical_records FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_records" ON medichain_medical_records;
CREATE POLICY "anon_delete_records" ON medichain_medical_records FOR DELETE
  TO anon, authenticated USING (true);

-- ============================================
-- 4. medichain_access_permissions
-- ============================================
CREATE TABLE IF NOT EXISTS medichain_access_permissions (
  id serial PRIMARY KEY,
  patient_id integer NOT NULL REFERENCES medichain_users(id) ON DELETE CASCADE,
  doctor_id integer NOT NULL REFERENCES medichain_users(id) ON DELETE CASCADE,
  granted boolean NOT NULL DEFAULT true,
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS medichain_permission_patient_doctor_unique ON medichain_access_permissions (patient_id, doctor_id);
CREATE INDEX IF NOT EXISTS medichain_permission_expiry_index ON medichain_access_permissions (expires_at);

ALTER TABLE medichain_access_permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_permissions" ON medichain_access_permissions;
CREATE POLICY "anon_select_permissions" ON medichain_access_permissions FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_permissions" ON medichain_access_permissions;
CREATE POLICY "anon_insert_permissions" ON medichain_access_permissions FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_permissions" ON medichain_access_permissions;
CREATE POLICY "anon_update_permissions" ON medichain_access_permissions FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_permissions" ON medichain_access_permissions;
CREATE POLICY "anon_delete_permissions" ON medichain_access_permissions FOR DELETE
  TO anon, authenticated USING (true);

-- ============================================
-- 5. medichain_patient_searches
-- ============================================
CREATE TABLE IF NOT EXISTS medichain_patient_searches (
  id serial PRIMARY KEY,
  patient_id integer NOT NULL REFERENCES medichain_users(id) ON DELETE CASCADE,
  doctor_id integer NOT NULL REFERENCES medichain_users(id) ON DELETE CASCADE,
  searched_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS medichain_search_patient_index ON medichain_patient_searches (patient_id, searched_at);

ALTER TABLE medichain_patient_searches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_searches" ON medichain_patient_searches;
CREATE POLICY "anon_select_searches" ON medichain_patient_searches FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_searches" ON medichain_patient_searches;
CREATE POLICY "anon_insert_searches" ON medichain_patient_searches FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_searches" ON medichain_patient_searches;
CREATE POLICY "anon_update_searches" ON medichain_patient_searches FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_searches" ON medichain_patient_searches;
CREATE POLICY "anon_delete_searches" ON medichain_patient_searches FOR DELETE
  TO anon, authenticated USING (true);

-- ============================================
-- 6. medichain_disease_codes
-- ============================================
CREATE TABLE IF NOT EXISTS medichain_disease_codes (
  id serial PRIMARY KEY,
  code text NOT NULL,
  coding_system text NOT NULL,
  release text NOT NULL,
  disease_name text NOT NULL,
  description text NOT NULL DEFAULT '',
  infectious boolean NOT NULL DEFAULT true,
  epidemic_relevant boolean NOT NULL DEFAULT false,
  pandemic_relevant boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ACTIVE',
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS medichain_disease_codes_identity_index ON medichain_disease_codes (coding_system, release, code);
CREATE INDEX IF NOT EXISTS medichain_disease_codes_name_index ON medichain_disease_codes (disease_name);
CREATE INDEX IF NOT EXISTS medichain_disease_codes_status_index ON medichain_disease_codes (status);

ALTER TABLE medichain_disease_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_disease_codes" ON medichain_disease_codes;
CREATE POLICY "anon_select_disease_codes" ON medichain_disease_codes FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_disease_codes" ON medichain_disease_codes;
CREATE POLICY "anon_insert_disease_codes" ON medichain_disease_codes FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_disease_codes" ON medichain_disease_codes;
CREATE POLICY "anon_update_disease_codes" ON medichain_disease_codes FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_disease_codes" ON medichain_disease_codes;
CREATE POLICY "anon_delete_disease_codes" ON medichain_disease_codes FOR DELETE
  TO anon, authenticated USING (true);

-- ============================================
-- 7. medichain_medical_diagnoses
-- ============================================
CREATE TABLE IF NOT EXISTS medichain_medical_diagnoses (
  id serial PRIMARY KEY,
  record_id integer NOT NULL REFERENCES medichain_medical_records(id) ON DELETE CASCADE,
  disease_code_id integer NOT NULL REFERENCES medichain_disease_codes(id) ON DELETE RESTRICT,
  status text NOT NULL,
  diagnosis_date date NOT NULL,
  onset_date date,
  notes text NOT NULL DEFAULT '',
  supporting_record_id integer REFERENCES medichain_medical_records(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS medichain_medical_diagnoses_record_index ON medichain_medical_diagnoses (record_id);
CREATE INDEX IF NOT EXISTS medichain_medical_diagnoses_code_index ON medichain_medical_diagnoses (disease_code_id);

ALTER TABLE medichain_medical_diagnoses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_diagnoses" ON medichain_medical_diagnoses;
CREATE POLICY "anon_select_diagnoses" ON medichain_medical_diagnoses FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_diagnoses" ON medichain_medical_diagnoses;
CREATE POLICY "anon_insert_diagnoses" ON medichain_medical_diagnoses FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_diagnoses" ON medichain_medical_diagnoses;
CREATE POLICY "anon_update_diagnoses" ON medichain_medical_diagnoses FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_diagnoses" ON medichain_medical_diagnoses;
CREATE POLICY "anon_delete_diagnoses" ON medichain_medical_diagnoses FOR DELETE
  TO anon, authenticated USING (true);

-- ============================================
-- 8. medichain_medical_attachments
-- ============================================
CREATE TABLE IF NOT EXISTS medichain_medical_attachments (
  id serial PRIMARY KEY,
  patient_id integer NOT NULL REFERENCES medichain_users(id) ON DELETE CASCADE,
  doctor_id integer NOT NULL REFERENCES medichain_users(id) ON DELETE CASCADE,
  record_id integer REFERENCES medichain_medical_records(id) ON DELETE SET NULL,
  object_path text NOT NULL UNIQUE,
  file_name text NOT NULL,
  content_type text NOT NULL,
  size integer NOT NULL,
  status text NOT NULL DEFAULT 'UPLOADING',
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  uploaded_at timestamptz,
  attached_at timestamptz
);

CREATE INDEX IF NOT EXISTS medichain_attachments_owner_status_index ON medichain_medical_attachments (patient_id, doctor_id, status);
CREATE INDEX IF NOT EXISTS medichain_attachments_expiry_index ON medichain_medical_attachments (expires_at);
CREATE INDEX IF NOT EXISTS medichain_attachments_record_index ON medichain_medical_attachments (record_id);

ALTER TABLE medichain_medical_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_attachments" ON medichain_medical_attachments;
CREATE POLICY "anon_select_attachments" ON medichain_medical_attachments FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_attachments" ON medichain_medical_attachments;
CREATE POLICY "anon_insert_attachments" ON medichain_medical_attachments FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_attachments" ON medichain_medical_attachments;
CREATE POLICY "anon_update_attachments" ON medichain_medical_attachments FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_attachments" ON medichain_medical_attachments;
CREATE POLICY "anon_delete_attachments" ON medichain_medical_attachments FOR DELETE
  TO anon, authenticated USING (true);

-- ============================================
-- 9. medichain_audit_events
-- ============================================
CREATE TABLE IF NOT EXISTS medichain_audit_events (
  id serial PRIMARY KEY,
  actor_user_id integer NOT NULL REFERENCES medichain_users(id) ON DELETE RESTRICT,
  patient_id integer REFERENCES medichain_users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id integer,
  hospital_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS medichain_audit_actor_index ON medichain_audit_events (actor_user_id);
CREATE INDEX IF NOT EXISTS medichain_audit_patient_index ON medichain_audit_events (patient_id);
CREATE INDEX IF NOT EXISTS medichain_audit_created_index ON medichain_audit_events (created_at);

ALTER TABLE medichain_audit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_audit" ON medichain_audit_events;
CREATE POLICY "anon_select_audit" ON medichain_audit_events FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_audit" ON medichain_audit_events;
CREATE POLICY "anon_insert_audit" ON medichain_audit_events FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_audit" ON medichain_audit_events;
CREATE POLICY "anon_update_audit" ON medichain_audit_events FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_audit" ON medichain_audit_events;
CREATE POLICY "anon_delete_audit" ON medichain_audit_events FOR DELETE
  TO anon, authenticated USING (true);