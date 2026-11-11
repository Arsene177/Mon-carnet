// Two-step sign-in with an authenticator app: setup (QR code, first code, recovery codes) and
// the Profile card to see its status, get new recovery codes, or turn it off (patients only).
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { Copy, Download, ShieldCheck } from 'lucide-react';
import {
  getGetMeQueryKey, getGetMfaStatusQueryKey, useDisableMfa, useEnableMfa, useGetMfaStatus,
  useRegenerateMfaRecoveryCodes, useStartMfaSetup,
} from '@workspace/api-client-react';
import type { MfaSetup, User } from '@workspace/api-client-react';
import { t } from '@/lib/i18n';
import { errText } from '@/lib/error-text';
import { keepThisDeviceSignedIn } from '@/lib/session';

/** Shows recovery codes once, with copy and download, and asks the person to confirm they kept them. */
function RecoveryCodes({ codes, onDone, doneLabel }: { codes: string[]; onDone: () => void; doneLabel: string }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = `Mon carnet — ${t('Recovery codes')}\n${t('Each code works once. Keep them somewhere safe, away from your phone.')}\n\n${codes.join('\n')}\n`;
  const copy = () => { void navigator.clipboard?.writeText(codes.join('\n')).then(() => setCopied(true)).catch(() => undefined); };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: 'mon-carnet-recovery-codes.txt' });
    link.click();
    // Revoking at once can cancel the download in some browsers.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div>
    <p className="field-note" style={{ marginBottom: 12 }}>{t('If you lose your phone, sign in with one of these codes instead. Each code works once. Keep them somewhere safe, away from your phone. They will not be shown again.')}</p>
    <ol className="recovery-codes" aria-label={t('Recovery codes')} data-testid="list-recovery-codes">{codes.map((code) => <li key={code}><code>{code}</code></li>)}</ol>
    <div className="row-actions" style={{ margin: '12px 0' }}>
      <button className="btn small secondary" type="button" onClick={copy}><Copy size={13}/> {copied ? t('Copied') : t('Copy')}</button>
      <button className="btn small secondary" type="button" onClick={download}><Download size={13}/> {t('Download')}</button>
    </div>
    <label className="consent-line"><input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} data-testid="checkbox-recovery-saved"/><span>{t('I have saved my recovery codes.')}</span></label>
    <div className="form-actions"><button className="btn" type="button" disabled={!saved} onClick={onDone} data-testid="button-recovery-done">{doneLabel}</button></div>
  </div>;
}

/** Password → scan the QR code → first code → recovery codes. Calls onDone when finished. */
export function MfaSetupFlow({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const start = useStartMfaSetup();
  const enable = useEnableMfa();
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!setup) return;
    QRCode.toDataURL(setup.otpauthUrl, { margin: 1, width: 200 }).then(setQr).catch(() => setQr(''));
  }, [setup]);

  const submitPassword = (event: FormEvent) => {
    event.preventDefault();
    setError('');
    start.mutate({ data: { password } }, { onSuccess: (result) => { setSetup(result); setPassword(''); }, onError: (e) => setError(errText(e)) });
  };
  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    setError('');
    enable.mutate({ data: { code: code.trim() } }, {
      onSuccess: (result) => {
        // Turning it on ends the other sessions, this one included: keep this device signed in.
        keepThisDeviceSignedIn(result.token);
        setRecoveryCodes(result.recoveryCodes);
      },
      onError: (e) => setError(errText(e)),
    });
  };

  if (recoveryCodes) return <><h3 className="step-title">{t('Step 3 of 3: save your recovery codes')}</h3><RecoveryCodes codes={recoveryCodes} onDone={onDone} doneLabel={t('Finish')}/></>;

  if (setup) return <form onSubmit={submitCode}>
    <h3 className="step-title">{t('Step 2 of 3: add Mon carnet to your authenticator app')}</h3>
    <p className="field-note">{t('Open an authenticator app on your phone (for example Google Authenticator, Microsoft Authenticator or Aegis), choose to add an account, and scan this code.')}</p>
    <div className="mfa-qr">{qr ? <img src={qr} width={200} height={200} alt={t('QR code to scan with your authenticator app')}/> : <div className="skeleton" style={{ width: 200, height: 200 }}/>}</div>
    <details className="field-note" style={{ marginBottom: 12 }}><summary>{t('Cannot scan? Enter this key instead')}</summary><code className="mfa-secret" data-testid="text-mfa-secret">{setup.secret.match(/.{1,4}/g)?.join(' ')}</code></details>
    <div className="field"><label htmlFor="mfa-code">{t('6-digit code shown in the app')}</label><input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required value={code} onChange={(event) => setCode(event.target.value)} data-testid="input-mfa-code"/></div>
    {error && <p className="error-state" role="alert">{error}</p>}
    <div className="form-actions">{onCancel && <button className="btn ghost" type="button" onClick={onCancel}>{t('Cancel')}</button>}<button className="btn" type="submit" disabled={enable.isPending} data-testid="button-mfa-confirm">{enable.isPending ? t('Checking…') : t('Turn on')}</button></div>
  </form>;

  return <form onSubmit={submitPassword}>
    <h3 className="step-title">{t('Step 1 of 3: confirm it is you')}</h3>
    <div className="field"><label htmlFor="mfa-password">{t('Current password')}</label><input id="mfa-password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} data-testid="input-mfa-password"/></div>
    {error && <p className="error-state" role="alert">{error}</p>}
    <div className="form-actions">{onCancel && <button className="btn ghost" type="button" onClick={onCancel}>{t('Cancel')}</button>}<button className="btn" type="submit" disabled={start.isPending} data-testid="button-mfa-start">{start.isPending ? t('Please wait…') : t('Continue')}</button></div>
  </form>;
}

/** Password plus a code from the app (or a recovery code), for turning off or new recovery codes. */
function PasswordAndCodeForm({ submitLabel, busy, error, onSubmit, onCancel, danger = false }: {
  submitLabel: string; busy: boolean; error: string; danger?: boolean;
  onSubmit: (password: string, code: string) => void; onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  return <form className="form-grid" onSubmit={(event) => { event.preventDefault(); onSubmit(password, code.trim()); }}>
    <div className="field"><label htmlFor="mfa-confirm-password">{t('Current password')}</label><input id="mfa-confirm-password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)}/></div>
    <div className="field"><label htmlFor="mfa-confirm-code">{t('Code from your app or a recovery code')}</label><input id="mfa-confirm-code" autoComplete="one-time-code" required maxLength={20} value={code} onChange={(event) => setCode(event.target.value)}/></div>
    {error && <p className="error-state full" role="alert">{error}</p>}
    <div className="form-actions full"><button className="btn ghost" type="button" onClick={onCancel}>{t('Cancel')}</button><button className={`btn ${danger ? 'danger' : ''}`} type="submit" disabled={busy}>{busy ? t('Please wait…') : submitLabel}</button></div>
  </form>;
}

/** Profile card: status, turn on, new recovery codes, and (patients only) turn off. */
export function TwoStepCard({ user }: { user: User }) {
  const qc = useQueryClient();
  const status = useGetMfaStatus();
  const regenerate = useRegenerateMfaRecoveryCodes();
  const disable = useDisableMfa();
  const [mode, setMode] = useState<'idle' | 'setup' | 'regenerate' | 'disable'>('idle');
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: getGetMfaStatusQueryKey() });
    void qc.invalidateQueries({ queryKey: getGetMeQueryKey() });
  };
  const close = () => { setMode('idle'); setError(''); };
  const enabled = status.data?.enabled ?? user.mfaEnabled;

  return <section className="panel" style={{ marginTop: 17 }}>
    <div className="panel-head"><div><h2 className="panel-title">{t('Two-step sign-in')}</h2><p className="panel-caption">{user.mfaRequired ? t('Required for doctors and administrators. After your password, you also enter a code from an app on your phone.') : t('Recommended. After your password, you also enter a code from an app on your phone, so a stolen password is not enough.')}</p></div><ShieldCheck size={17} color="#69a293"/></div>
    <div className="panel-body">
      <div className="data-row"><span className="data-key">{t('Status')}</span><span className="data-value">{enabled ? <span className="tag certified">{t('On')}</span> : <span className="tag warning">{t('Off')}</span>}</span></div>
      {enabled && <div className="data-row"><span className="data-key">{t('Recovery codes left')}</span><span className="data-value">{status.data?.recoveryCodesRemaining ?? '…'}</span></div>}
      {enabled && status.data && status.data.recoveryCodesRemaining <= 3 && mode === 'idle' && !newCodes && <p className="field-note" role="status">{t('You are running out of recovery codes. Get new ones.')}</p>}
      {message && <p className="field-note" role="status">{message}</p>}
      {newCodes ? <RecoveryCodes codes={newCodes} doneLabel={t('Done')} onDone={() => { setNewCodes(null); refresh(); }}/>
        : mode === 'setup' ? <MfaSetupFlow onCancel={close} onDone={() => { close(); setMessage(t('Two-step sign-in is on. You have been signed out on your other devices.')); refresh(); }}/>
        : mode === 'regenerate' ? <PasswordAndCodeForm submitLabel={t('Get new recovery codes')} busy={regenerate.isPending} error={error} onCancel={close}
            onSubmit={(password, code) => { setError(''); regenerate.mutate({ data: { password, code } }, { onSuccess: (result) => { close(); setNewCodes(result.recoveryCodes); }, onError: (e) => setError(errText(e)) }); }}/>
        : mode === 'disable' ? <PasswordAndCodeForm danger submitLabel={t('Turn off')} busy={disable.isPending} error={error} onCancel={close}
            onSubmit={(password, code) => { setError(''); disable.mutate({ data: { password, code } }, { onSuccess: () => { close(); setMessage(t('Two-step sign-in is off.')); refresh(); }, onError: (e) => setError(errText(e)) }); }}/>
        : <div className="form-actions">
            {!enabled && <button className="btn" type="button" onClick={() => { setMessage(''); setMode('setup'); }} data-testid="button-mfa-turn-on">{t('Turn on two-step sign-in')}</button>}
            {enabled && <button className="btn secondary" type="button" onClick={() => { setMessage(''); setMode('regenerate'); }} data-testid="button-mfa-new-codes">{t('Get new recovery codes')}</button>}
            {enabled && !user.mfaRequired && <button className="btn ghost" type="button" onClick={() => { setMessage(''); setMode('disable'); }} data-testid="button-mfa-turn-off">{t('Turn off')}</button>}
          </div>}
    </div>
  </section>;
}
