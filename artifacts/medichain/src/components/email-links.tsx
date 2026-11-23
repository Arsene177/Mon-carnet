// Pages behind the links sent by email (/verify-email, /reset-password), and the "check your
// email" notice with a button to send the confirmation email again.
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useResendVerificationEmail, useResetPasswordWithEmailLink, useVerifyEmail } from '@workspace/api-client-react';
import { t } from '@/lib/i18n';
import { errText } from '@/lib/error-text';

/** Reads ?token= once and removes it from the address bar and history, so it is not left behind. */
function useLinkToken(): string {
  const [token] = useState(() => new URLSearchParams(window.location.search).get('token') ?? '');
  useEffect(() => { window.history.replaceState(null, '', window.location.pathname); }, []);
  return token;
}

function LinkPage({ title, children }: { title: string; children: React.ReactNode }) {
  useEffect(() => { document.title = `${title} · Mon carnet`; }, [title]);
  return <div className="login-page consent-page">
    <main className="login-main" id="main-content">
      <div className="auth-card">
        <div className="brand-inline"><span className="brand-name">Mon <strong>carnet</strong></span></div>
        <h1 className="auth-title">{title}</h1>
        {children}
      </div>
    </main>
  </div>;
}

const SignInLink = () => <div className="form-actions"><a className="btn" href="/login" data-testid="link-sign-in">{t('Go to sign in')}</a></div>;

export function VerifyEmailPage() {
  const token = useLinkToken();
  const verify = useVerifyEmail();
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !token) return;
    started.current = true;
    verify.mutate({ data: { token } });
  }, [token, verify]);
  return <LinkPage title={t('Confirm your email address')}>
    {!token || verify.isError ? <>
      <div className="auth-feedback" role="alert"><span>{verify.isError ? errText(verify.error) : t('This link is invalid, already used or expired. Ask for a new one.')}</span></div>
      <p>{t('On the sign-in page, enter your email and password: you can ask for a new confirmation email there.')}</p>
      <SignInLink/>
    </> : verify.isSuccess ? <>
      <div className="notice" role="status" data-testid="text-email-verified">{t('Your email address is confirmed. You can now sign in.')}</div>
      <SignInLink/>
    </> : <p role="status">{t('Checking your link…')}</p>}
  </LinkPage>;
}

export function ResetPasswordPage() {
  const token = useLinkToken();
  const reset = useResetPasswordWithEmailLink();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (password !== confirm) { setError(t('The new passwords do not match.')); return; }
    reset.mutate({ data: { token, newPassword: password } }, { onError: (cause) => setError(errText(cause)) });
  };
  return <LinkPage title={t('Choose a new password')}>
    {!token ? <>
      <div className="auth-feedback" role="alert"><span>{t('This link is invalid, already used or expired. Ask for a new one.')}</span></div>
      <SignInLink/>
    </> : reset.isSuccess ? <>
      <div className="notice" role="status" data-testid="text-password-reset">{t('Your password is changed. Sign in with it; every other session has ended.')}</div>
      <SignInLink/>
    </> : <form onSubmit={submit}>
      <p>{t('Choose a password of at least 8 characters that you do not use anywhere else.')}</p>
      <div className="field"><label htmlFor="reset-password">{t('New password')}</label><input id="reset-password" type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={password} onChange={(event) => setPassword(event.target.value)} data-testid="input-reset-password"/></div>
      <div className="field"><label htmlFor="reset-confirm">{t('Confirm new password')}</label><input id="reset-confirm" type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={confirm} onChange={(event) => setConfirm(event.target.value)} data-testid="input-reset-confirm"/></div>
      {error && <div className="auth-feedback" role="alert"><span>{error}</span></div>}
      <button className="btn auth-submit" type="submit" disabled={reset.isPending} data-testid="button-reset-password">{reset.isPending ? t('Please wait…') : t('Change password')}</button>
    </form>}
  </LinkPage>;
}

/** After registering, or when signing in before confirming: explains and offers to send the link again. */
export function CheckEmailNotice({ email, emailSent = true }: { email: string; emailSent?: boolean }) {
  const resend = useResendVerificationEmail();
  return <div className="notice" role="status" data-testid="notice-check-email">
    <p style={{ margin: '0 0 8px' }}>{emailSent
      ? t('We sent a confirmation link to {0}. Open it to activate your account, then sign in. It works for 24 hours; check your spam folder too.', { 0: email })
      : t('Your account is created, but the confirmation email could not be sent. Ask for it again below.')}</p>
    {resend.isSuccess
      ? <p style={{ margin: 0 }}>{t('If this account is waiting for confirmation, a new link is on its way.')}</p>
      : <button className="btn small secondary" type="button" disabled={resend.isPending} onClick={() => resend.mutate({ data: { email } })} data-testid="button-resend-verification">{resend.isPending ? t('Please wait…') : t('Send the email again')}</button>}
    {resend.isError && <p className="error-state" role="alert" style={{ marginTop: 8 }}>{errText(resend.error)}</p>}
  </div>;
}
