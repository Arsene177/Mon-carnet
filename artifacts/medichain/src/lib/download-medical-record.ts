import type { MedicalRecord } from '@workspace/api-client-react';
import { locale, t } from './i18n';

function formatDate(value?: string | null): string {
  if (!value) return t("Not provided");
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

export function downloadMedicalRecord(record: MedicalRecord, patientDisplayId?: string): void {
  const lines = [
    t("MEDICHAIN MEDICAL RECORD"),
    '========================',
    t("Record ID: {0}", { 0: record.id }),
    ...(patientDisplayId ? [t("Patient ID: {0}", { 0: patientDisplayId })] : []),
    t("Record type: {0}", { 0: record.recordType }),
    t("Entered by: {0}", { 0: record.doctorName }),
    t("Created: {0}", { 0: formatDate(record.createdAt) }),
    t("Follow-up to record: {0}", { 0: record.followUpToRecordId ?? t("None") }),
    '',
    'DIAGNOSIS',
    '---------',
    record.diagnosis || t("No diagnosis documented."),
    '',
    t("STRUCTURED DISEASE DIAGNOSES"),
    '----------------------------',
  ];

  if (record.codedDiagnoses.length === 0) {
    lines.push('None');
  } else {
    for (const [index, diagnosis] of record.codedDiagnoses.entries()) {
      lines.push(
        `${index + 1}. ${t(diagnosis.diseaseCode.diseaseName)} (${diagnosis.diseaseCode.code})`,
        t("   Coding system: {0} {1}", { 0: diagnosis.diseaseCode.codingSystem, 1: diagnosis.diseaseCode.release }),
        t("   Status: {0}", { 0: diagnosis.status.replaceAll('_', ' ') }),
        t("   Diagnosis date: {0}", { 0: formatDate(diagnosis.diagnosisDate) }),
        t("   Onset date: {0}", { 0: formatDate(diagnosis.onsetDate) }),
        t("   Notes: {0}", { 0: diagnosis.notes || t("None") }),
        t("   Supporting record: {0}", { 0: diagnosis.supportingRecordId ?? t("None") }),
        t("   Source: {0}", { 0: diagnosis.diseaseCode.source }),
        '',
      );
    }
  }

  lines.push(
    'TREATMENT / PLAN',
    '----------------',
    record.treatment || t("No treatment or plan documented."),
    '',
    'MEDICATIONS',
    '-----------',
    record.medications.length > 0 ? record.medications.join(', ') : t("None documented."),
    '',
    'CLINICAL NOTES',
    '--------------',
    record.notes || t("No additional notes."),
    '',
    'VITALS',
    '------',
    t("Blood pressure: {0}", { 0: record.vitals.bloodPressure || t("Not recorded") }),
    t("Heart rate: {0}", { 0: record.vitals.heartRate ? `${record.vitals.heartRate} bpm` : t("Not recorded") }),
    t("Temperature: {0}", { 0: record.vitals.temperature ? `${record.vitals.temperature} °C` : t("Not recorded") }),
    t("Weight: {0}", { 0: record.vitals.weightKg ? `${record.vitals.weightKg} kg` : t("Not recorded") }),
  );

  downloadTextFile(`medichain-record-${record.id}.txt`, `\uFEFF${lines.join('\n')}`);
}