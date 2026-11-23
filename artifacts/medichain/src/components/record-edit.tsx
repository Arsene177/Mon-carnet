// Correcting a record (only its author, within the edit window) and viewing its earlier versions.
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useEditDoctorPatientRecord, useGetMedicalRecordHistory, getGetMedicalRecordHistoryQueryKey } from '@workspace/api-client-react';
import type { MedicalRecord } from '@workspace/api-client-react';
import { locale, t } from '@/lib/i18n';
import { errText } from '@/lib/error-text';
import { splitRecordAttachments } from '@/lib/record-attachments';

const timeLabel = (value: string) => new Date(value).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const numberOrNull = (value: string) => (value.trim() === '' ? null : Number(value.replace(',', '.')));

/** The "Correct this record" button and form, for the doctor who wrote it while there is still time. */
export function RecordCorrection({ record, onSaved }: { record: MedicalRecord; onSaved: (record: MedicalRecord) => void }) {
  const edit = useEditDoctorPatientRecord();
  const [open, setOpen] = useState(false);
  const [diagnosis, setDiagnosis] = useState(record.diagnosis);
  const [treatment, setTreatment] = useState(record.treatment);
  const [medications, setMedications] = useState(record.medications.join(', '));
  const [notes, setNotes] = useState(splitRecordAttachments(record.notes).notes);
  const [bloodPressure, setBloodPressure] = useState(record.vitals.bloodPressure ?? '');
  const [heartRate, setHeartRate] = useState(record.vitals.heartRate?.toString() ?? '');
  const [temperature, setTemperature] = useState(record.vitals.temperature?.toString() ?? '');
  const [weightKg, setWeightKg] = useState(record.vitals.weightKg?.toString() ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  if (!record.editableUntil) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError('');
    edit.mutate({
      patientId: record.patientId,
      recordId: record.id,
      data: {
        diagnosis: diagnosis.trim(),
        treatment: treatment.trim(),
        medications: medications.split(',').map((item) => item.trim()).filter(Boolean),
        notes: notes.trim(),
        vitals: { bloodPressure: bloodPressure.trim() || null, heartRate: numberOrNull(heartRate), temperature: numberOrNull(temperature), weightKg: numberOrNull(weightKg) },
        reason: reason.trim(),
      },
    }, {
      onSuccess: (saved) => { setOpen(false); setReason(''); onSaved(saved); },
      onError: (cause) => setError(errText(cause)),
    });
  };
  if (!open) {
    return <button type="button" className="btn secondary" onClick={() => setOpen(true)} data-testid={`button-correct-record-${record.id}`}>{t('Correct this record (until {0})', { 0: timeLabel(record.editableUntil) })}</button>;
  }
  return <section className="record-detail-section" aria-labelledby={`correct-${record.id}`}>
    <h3 id={`correct-${record.id}`}>{t('Correct this record')}</h3>
    <p className="field-note">{t('Only you, who wrote it, can correct it until {0}. The earlier version stays visible in its history, and the patient is told.', { 0: timeLabel(record.editableUntil) })}</p>
    <form className="form-grid" onSubmit={submit}>
      <div className="field full"><label htmlFor={`fix-diagnosis-${record.id}`}>{t('Diagnosis')}</label><textarea id={`fix-diagnosis-${record.id}`} maxLength={5000} value={diagnosis} onChange={(event) => setDiagnosis(event.target.value)}/></div>
      <div className="field full"><label htmlFor={`fix-treatment-${record.id}`}>{t('Treatment / plan')}</label><textarea id={`fix-treatment-${record.id}`} maxLength={5000} value={treatment} onChange={(event) => setTreatment(event.target.value)}/></div>
      <div className="field full"><label htmlFor={`fix-medications-${record.id}`}>{t('Medications (separated by commas)')}</label><input id={`fix-medications-${record.id}`} value={medications} onChange={(event) => setMedications(event.target.value)}/></div>
      <div className="field full"><label htmlFor={`fix-notes-${record.id}`}>{t('Clinical notes')}</label><textarea id={`fix-notes-${record.id}`} maxLength={10000} value={notes} onChange={(event) => setNotes(event.target.value)}/></div>
      <div className="field"><label htmlFor={`fix-bp-${record.id}`}>{t('Blood pressure')}</label><input id={`fix-bp-${record.id}`} maxLength={30} value={bloodPressure} onChange={(event) => setBloodPressure(event.target.value)}/></div>
      <div className="field"><label htmlFor={`fix-hr-${record.id}`}>{t('Heart rate')}</label><input id={`fix-hr-${record.id}`} inputMode="numeric" value={heartRate} onChange={(event) => setHeartRate(event.target.value)}/></div>
      <div className="field"><label htmlFor={`fix-temp-${record.id}`}>{t('Temperature')}</label><input id={`fix-temp-${record.id}`} inputMode="decimal" value={temperature} onChange={(event) => setTemperature(event.target.value)}/></div>
      <div className="field"><label htmlFor={`fix-weight-${record.id}`}>{t('Weight')}</label><input id={`fix-weight-${record.id}`} inputMode="decimal" value={weightKg} onChange={(event) => setWeightKg(event.target.value)}/></div>
      <div className="field full"><label htmlFor={`fix-reason-${record.id}`}>{t('Reason for the correction')}</label><input id={`fix-reason-${record.id}`} required minLength={5} maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t('For example: typing error, lab result received')} data-testid={`input-correction-reason-${record.id}`}/></div>
      {error && <p className="error-state full" role="alert">{error}</p>}
      <div className="form-actions full"><button type="button" className="btn ghost" onClick={() => setOpen(false)}>{t('Cancel')}</button><button type="submit" className="btn" disabled={edit.isPending} data-testid={`button-save-correction-${record.id}`}>{edit.isPending ? t('Saving…') : t('Save the correction')}</button></div>
    </form>
  </section>;
}

/** Earlier versions of a corrected record, newest first. */
export function RecordHistory({ record }: { record: MedicalRecord }) {
  const [open, setOpen] = useState(false);
  const history = useGetMedicalRecordHistory(record.id, { query: { enabled: open && (record.editCount ?? 0) > 0, queryKey: getGetMedicalRecordHistoryQueryKey(record.id) } });
  if (!record.editedAt || !record.editCount) return null;
  return <section className="record-detail-section">
    <h3>{t('Corrections')}</h3>
    <p className="field-note">{t('Corrected {0} time(s), last on {1} by the doctor who wrote it.', { 0: record.editCount, 1: timeLabel(record.editedAt) })}</p>
    {!open ? <button type="button" className="btn small secondary" onClick={() => setOpen(true)} data-testid={`button-record-history-${record.id}`}>{t('Show earlier versions')}</button>
      : history.isLoading ? <p role="status">{t('Loading…')}</p>
      : history.error ? <p className="error-state" role="alert">{errText(history.error)}</p>
      : (history.data ?? []).map((version) => {
        const { notes } = splitRecordAttachments(version.notes);
        return <article className="callout" key={version.version} style={{ marginBottom: 10 }} data-testid={`record-version-${version.version}`}>
          <p style={{ margin: '0 0 6px' }}><strong>{t('Version {0}', { 0: version.version })}</strong> · {t('replaced on {0} by {1}', { 0: timeLabel(version.replacedAt), 1: version.replacedByName })}</p>
          <p style={{ margin: '0 0 6px' }}><strong>{t('Reason:')}</strong> {version.changeReason}</p>
          <p style={{ margin: '0 0 4px' }}><strong>{t('Diagnosis')}:</strong> {version.diagnosis || t('No diagnosis documented.')}</p>
          <p style={{ margin: '0 0 4px' }}><strong>{t('Treatment / plan')}:</strong> {version.treatment || t('No treatment or plan documented.')}</p>
          <p style={{ margin: '0 0 4px' }}><strong>{t('Medications')}:</strong> {version.medications.length ? version.medications.join(', ') : t('No medications documented.')}</p>
          <p style={{ margin: 0 }}><strong>{t('Clinical notes')}:</strong> {notes || t('No additional notes.')}</p>
        </article>;
      })}
  </section>;
}
