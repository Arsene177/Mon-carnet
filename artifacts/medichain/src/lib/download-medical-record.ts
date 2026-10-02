import type { MedicalRecord } from '@workspace/api-client-react';

function formatDate(value?: string | null): string {
  if (!value) return 'Not provided';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00`)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function downloadTextFile(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadMedicalRecord(record: MedicalRecord): void {
  const lines = [
    'MEDICHAIN MEDICAL RECORD',
    '========================',
    `Record ID: ${record.id}`,
    `Patient ID: ${record.patientId}`,
    `Record type: ${record.recordType}`,
    `Entered by: ${record.doctorName}`,
    `Created: ${formatDate(record.createdAt)}`,
    `Follow-up to record: ${record.followUpToRecordId ?? 'None'}`,
    '',
    'DIAGNOSIS',
    '---------',
    record.diagnosis || 'No diagnosis documented.',
    '',
    'STRUCTURED DISEASE DIAGNOSES',
    '----------------------------',
  ];

  if (record.codedDiagnoses.length === 0) {
    lines.push('None');
  } else {
    for (const [index, diagnosis] of record.codedDiagnoses.entries()) {
      lines.push(
        `${index + 1}. ${diagnosis.diseaseCode.diseaseName} (${diagnosis.diseaseCode.code})`,
        `   Coding system: ${diagnosis.diseaseCode.codingSystem} ${diagnosis.diseaseCode.release}`,
        `   Status: ${diagnosis.status.replaceAll('_', ' ')}`,
        `   Diagnosis date: ${formatDate(diagnosis.diagnosisDate)}`,
        `   Onset date: ${formatDate(diagnosis.onsetDate)}`,
        `   Notes: ${diagnosis.notes || 'None'}`,
        `   Supporting record: ${diagnosis.supportingRecordId ?? 'None'}`,
        `   Source: ${diagnosis.diseaseCode.source}`,
        '',
      );
    }
  }

  lines.push(
    'TREATMENT / PLAN',
    '----------------',
    record.treatment || 'No treatment or plan documented.',
    '',
    'MEDICATIONS',
    '-----------',
    record.medications.length > 0 ? record.medications.join(', ') : 'None documented.',
    '',
    'CLINICAL NOTES',
    '--------------',
    record.notes || 'No additional notes.',
    '',
    'VITALS',
    '------',
    `Blood pressure: ${record.vitals.bloodPressure || 'Not recorded'}`,
    `Heart rate: ${record.vitals.heartRate ? `${record.vitals.heartRate} bpm` : 'Not recorded'}`,
    `Temperature: ${record.vitals.temperature ? `${record.vitals.temperature} °C` : 'Not recorded'}`,
    `Weight: ${record.vitals.weightKg ? `${record.vitals.weightKg} kg` : 'Not recorded'}`,
  );

  downloadTextFile(`medichain-record-${record.id}.txt`, `\uFEFF${lines.join('\n')}`);
}