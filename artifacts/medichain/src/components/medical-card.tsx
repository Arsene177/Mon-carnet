// The patient's medical card: name, CM ID and an optional photo, as a picture to download or print.
// The photo stays private: only the patient can add, see or remove it. Before it is sent, it is
// redrawn here at a small size, which also drops its metadata (such as where it was taken).
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { authorizedFetch } from '@/lib/session';
import { t } from '@/lib/i18n';

type CardDetails = { name: string; cmId: string; birth: string; sex: string; country: string };

const CARD_W = 1012;
const CARD_H = 638;
const NAVY = '#16304a';
const AMBER = '#f5a83a';

async function loadImage(src: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = src;
  await image.decode();
  return image;
}

/** Shrinks a photo to at most 600 px and re-encodes it as JPEG (no metadata). */
async function preparePhoto(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    const scale = Math.min(1, 600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);
    canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encode'))), 'image/jpeg', 0.88));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, size: number, weight: number) {
  let current = size;
  do { ctx.font = `${weight} ${current}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`; current -= 2; } while (ctx.measureText(text).width > maxWidth && current > 18);
}

/** Draws the card; returns a PNG data URL. */
export async function drawCard(details: CardDetails, photoUrl: string | null): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.roundRect(0, 0, CARD_W, CARD_H, 36); ctx.fill();
  ctx.save(); ctx.beginPath(); ctx.roundRect(0, 0, CARD_W, CARD_H, 36); ctx.clip();
  ctx.fillStyle = NAVY; ctx.fillRect(0, 0, CARD_W, 128);
  ctx.fillStyle = AMBER; ctx.fillRect(0, 128, CARD_W, 8);
  ctx.restore();
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 40px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.fillText('Mon carnet', 48, 66);
  ctx.font = '400 26px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.fillText(t('Medical card'), 48, 104);

  // Photo, or initials when there is none.
  const px = 48, py = 176, pw = 260, ph = 320;
  ctx.save(); ctx.beginPath(); ctx.roundRect(px, py, pw, ph, 20); ctx.clip();
  if (photoUrl) {
    const image = await loadImage(photoUrl);
    const scale = Math.max(pw / image.naturalWidth, ph / image.naturalHeight);
    const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
    ctx.drawImage(image, px + (pw - w) / 2, py + (ph - h) / 2, w, h);
  } else {
    ctx.fillStyle = '#e8edf2'; ctx.fillRect(px, py, pw, ph);
    ctx.fillStyle = NAVY; ctx.font = '600 96px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(details.name.split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase(), px + pw / 2, py + ph / 2 + 34);
    ctx.textAlign = 'left';
  }
  ctx.restore();

  const x = 350, maxWidth = CARD_W - x - 48;
  const label = (text: string, y: number) => { ctx.fillStyle = '#5c6d7d'; ctx.font = '500 22px system-ui, sans-serif'; ctx.fillText(text.toUpperCase(), x, y); };
  label(t('Name'), 200);
  ctx.fillStyle = '#10202f'; fitText(ctx, details.name, maxWidth, 44, 600); ctx.fillText(details.name, x, 248);
  label(t('Patient CM ID'), 312);
  ctx.fillStyle = NAVY; ctx.font = '700 64px ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace'; ctx.fillText(details.cmId, x, 378);
  label(t('Date of birth'), 436);
  ctx.fillStyle = '#10202f'; fitText(ctx, details.birth, maxWidth / 2 - 10, 28, 500); ctx.fillText(details.birth, x, 474);
  ctx.save(); ctx.translate(maxWidth / 2 + 10, 0); label(t('Sex'), 436); ctx.restore();
  ctx.fillStyle = '#10202f'; ctx.font = '500 28px system-ui, sans-serif'; ctx.fillText(details.sex, x + maxWidth / 2 + 10, 474);
  label(t('Country of origin'), 530);
  ctx.fillStyle = '#10202f'; fitText(ctx, details.country, maxWidth, 28, 500); ctx.fillText(details.country, x, 568);

  ctx.fillStyle = '#5c6d7d'; ctx.font = '400 20px system-ui, sans-serif';
  fitText(ctx, t('Show this card to your doctor: they enter your CM ID to open your booklet.'), CARD_W - 96, 20, 400);
  ctx.fillText(t('Show this card to your doctor: they enter your CM ID to open your booklet.'), 48, 612);
  return canvas.toDataURL('image/png');
}

export function MedicalCard({ details }: { details: CardDetails }) {
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [cardUrl, setCardUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const loadPhoto = async () => {
    const response = await authorizedFetch('/api/patient/photo');
    if (!response.ok) { setPhotoUrl(null); return; }
    setPhotoUrl(URL.createObjectURL(await response.blob()));
  };
  useEffect(() => { void loadPhoto().catch(() => setPhotoUrl(null)); }, []);
  useEffect(() => () => { if (photoUrl) URL.revokeObjectURL(photoUrl); }, [photoUrl]);
  useEffect(() => {
    let current = true;
    void drawCard(details, photoUrl).then((url) => { if (current) setCardUrl(url); }).catch(() => setCardUrl(null));
    return () => { current = false; };
  }, [details.name, details.cmId, details.birth, details.sex, details.country, photoUrl]);

  const choosePhoto = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true); setMessage('');
    try {
      const body = await preparePhoto(file);
      const response = await authorizedFetch('/api/patient/photo', { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body });
      if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? 'upload');
      await loadPhoto();
      setMessage(t('Photo saved.'));
    } catch (error) {
      setMessage(error instanceof Error && error.message !== 'upload' && error.message !== 'encode' ? t(error.message) : t('The photo could not be saved. Choose a JPEG or PNG photo and try again.'));
    } finally { setBusy(false); }
  };
  const removePhoto = async () => {
    setBusy(true); setMessage('');
    try {
      const response = await authorizedFetch('/api/patient/photo', { method: 'DELETE' });
      if (!response.ok) throw new Error('remove');
      setPhotoUrl(null);
      setMessage(t('Photo removed.'));
    } catch { setMessage(t('The photo could not be removed. Try again.')); } finally { setBusy(false); }
  };

  return <section className="panel" style={{ marginBottom: 17 }} aria-labelledby="medical-card-title">
    <div className="panel-head"><div><h2 className="panel-title" id="medical-card-title">{t('Medical card')}</h2><p className="panel-caption">{t('Your name, CM ID and photo on one card. Download it, print it or keep it on your phone.')}</p></div></div>
    <div className="panel-body">
      {cardUrl ? <img src={cardUrl} alt={t('Medical card for {0}, CM ID {1}', { 0: details.name, 1: details.cmId })} style={{ width: '100%', maxWidth: 506, height: 'auto', borderRadius: 18, boxShadow: '0 4px 18px rgba(16,32,47,.14)', display: 'block' }} data-testid="img-medical-card"/> : <div className="skeleton"/>}
      <div className="form-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap', marginTop: 14 }}>
        <a className={`btn${cardUrl ? '' : ' disabled'}`} href={cardUrl ?? undefined} download={`mon-carnet-${details.cmId}.png`} aria-disabled={!cardUrl} data-testid="button-download-card">{t('Download my card')}</a>
        <button type="button" className="btn secondary" onClick={() => fileInput.current?.click()} disabled={busy} data-testid="button-choose-photo">{photoUrl ? t('Change photo') : t('Add a photo')}</button>
        {photoUrl && <button type="button" className="btn ghost" onClick={removePhoto} disabled={busy} data-testid="button-remove-photo">{t('Remove photo')}</button>}
        <input ref={fileInput} type="file" accept="image/jpeg,image/png" hidden onChange={choosePhoto} data-testid="input-photo" aria-label={t('Photo for the medical card')}/>
      </div>
      <p className="field-note">{t('Optional. Only you can see your photo. It appears on your card, not in your medical records.')}</p>
      {message && <p role="status" className="field-note">{message}</p>}
    </div>
  </section>;
}
