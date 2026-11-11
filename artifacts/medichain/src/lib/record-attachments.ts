/**
 * Lab-result files are stored in a record's notes as "Attachment: <name>" followed by
 * "Attachment object: <path>" (up to five per record). Returns the notes without those lines
 * and the attached files in order.
 */
export function splitRecordAttachments(text: string): { notes: string; attachments: Array<{ fileName: string; objectPath: string }> } {
  const pattern = /(?:^|\r?\n)Attachment: ([^\r\n]*)\r?\nAttachment object: (\/objects\/uploads\/[0-9a-f-]{36})/g;
  const attachments = Array.from(text.matchAll(pattern), (match) => ({ fileName: match[1].trim(), objectPath: match[2] }));
  return { notes: text.replace(pattern, '').trim(), attachments };
}
