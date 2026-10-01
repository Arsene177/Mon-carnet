import { useEffect, useMemo, useState } from 'react';
import type { ChangeEvent, FormEvent, ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  Activity, AlertCircle, ArrowRight, BadgeCheck, BookOpen, CalendarDays, Check,
  ChevronRight, ClipboardList, Clock3, FileHeart, FilePlus2, HeartPulse, KeyRound,
  LockKeyhole, LogOut, Plus, Printer,
  Search, Shield, ShieldCheck, Stethoscope, Trash2, UserRound, Users, X,
} from 'lucide-react';
import {
  getGetAdminAnalyticsQueryKey, getGetAdminStatsQueryKey, getGetDoctorProfileQueryKey, getGetMeQueryKey,
  getGetPatientPendingRequestsQueryKey, getGetPatientPermissionsQueryKey,
  getGetPatientProfileQueryKey, getGetPatientRecordsQueryKey, getGetPendingDoctorsQueryKey,
  getGetDoctorPatientRecordsQueryKey, getGetDoctorStatsQueryKey, getGetPatientEmergencyQueryKey,
  getSearchPatientsQueryKey, getSearchUsersQueryKey, setAuthTokenGetter,
  useAddDoctorPatientRecord, useApproveDoctor, useGetAdminAnalytics, useGetAdminStats,
  useGetDoctorPatientRecords, useGetDoctorProfile, useGetDoctorStats, useGetMe,
  useGetPatientEmergency, useGetPatientPendingRequests, useGetPatientPermissions,
  useGetPatientProfile, useGetPatientRecords, useGetPendingDoctors, useGrantPatientPermission,
  useLogin, useRegister, useRevokeDoctor, useRevokePatientPermission, useSearchPatients,
  useSearchUsers, useUpdateEmergencyInfo,
} from '@workspace/api-client-react';
import type {
  EmergencyInfoInput, MedicalRecordInput, MedicalRecordRecordType, User,
} from '@workspace/api-client-react';
import { useLocation } from 'wouter';

const queryClient = new QueryClient();
setAuthTokenGetter(() => typeof localStorage === 'undefined' ? null : localStorage.getItem('medichain_token'));

type Tab = 'Overview' | 'Records' | 'Access control' | 'Emergency info' | 'Patients' | 'Record entry' | 'Profile' | 'System overview' | 'Doctor approvals' | 'User search' | 'Analytics';
const patientTabs: Tab[] = ['Overview', 'Records', 'Access control', 'Emergency info'];
const doctorTabs: Tab[] = ['Patients', 'Record entry', 'Profile'];
const adminTabs: Tab[] = ['System overview', 'Doctor approvals', 'User search', 'Analytics'];
const dateLabel = (date?: string | null) => date ? new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Not provided';
const initials = (name?: string) => (name || 'MC').split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase();
const errText = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';

function App() {
  return <QueryClientProvider client={queryClient}><Router /></QueryClientProvider>;
}

function Router() {
  const [location, setLocation] = useLocation();
  const token = typeof localStorage === 'undefined' ? null : localStorage.getItem('medichain_token');
  const me = useGetMe({ query: { enabled: Boolean(token), queryKey: getGetMeQueryKey(), retry: false } });
  const signOut = () => {
    localStorage.removeItem('medichain_token');
    queryClient.clear();
    setLocation('/');
  };
  if (location === '/' || location === '/login' || location === '/register' || !token) {
    if (token && me.data) {
      const target = me.data.role === 'ADMIN' ? '/admin' : me.data.role === 'DOCTOR' || me.data.role === 'PENDING_DOCTOR' ? '/doctor' : '/patient';
      if (location === '/' || location === '/login' || location === '/register') setLocation(target);
      return <LoadingScreen />;
    }
    if (token && me.isLoading) return <LoadingScreen />;
    return <AuthPage />;
  }
  if (me.isLoading) return <LoadingScreen />;
  if (me.error || !me.data) return <AuthPage />;
  const user = me.data;
  const expected = user.role === 'ADMIN' ? '/admin' : user.role === 'DOCTOR' || user.role === 'PENDING_DOCTOR' ? '/doctor' : '/patient';
  if (location !== expected && !location.startsWith(expected + '/')) {
    setLocation(expected);
    return <LoadingScreen />;
  }
  return <Workspace user={user} onSignOut={signOut} />;
}

function LoadingScreen() {
  return <div className="login-page"><div className="login-aside"><div className="brand"><span className="brand-mark"><HeartPulse size={20}/></span>medichain</div><div className="aside-copy"><p className="eyebrow">A clearer kind of care</p><h1>Your health story, in safe hands.</h1><p>One trusted place for the information that helps care move forward.</p></div><div className="aside-foot">Private by design · Built for patients and clinicians</div></div><main className="login-main"><div className="auth-card"><div className="skeleton"/></div></main></div>;
}

function AuthPage() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const [mode, setMode] = useState<'login' | 'register'>(location.pathname === '/register' ? 'register' : 'login');
  const [role, setRole] = useState<'PATIENT' | 'DOCTOR'>('PATIENT');
  const [form, setForm] = useState({ name: '', email: '', password: '', dateOfBirth: '', contactInfo: '' });
  const [feedback, setFeedback] = useState('');
  const login = useLogin();
  const register = useRegister();
  const busy = login.isPending || register.isPending;
  const onField = (key: keyof typeof form) => (event: ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: event.target.value });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFeedback('');
    const onSession = (session: { token: string; user: User }) => {
      localStorage.setItem('medichain_token', session.token);
      qc.setQueryData(getGetMeQueryKey(), session.user);
      const destination = session.user.role === 'ADMIN' ? '/admin' : session.user.role === 'DOCTOR' || session.user.role === 'PENDING_DOCTOR' ? '/doctor' : '/patient';
      setLocation(destination);
    };
    if (mode === 'login') {
      login.mutate({ data: { email: form.email.trim(), password: form.password } }, { onSuccess: onSession, onError: (error) => setFeedback(errText(error)) });
    } else {
      register.mutate({ data: { name: form.name.trim(), email: form.email.trim(), password: form.password, role, ...(form.dateOfBirth ? { dateOfBirth: form.dateOfBirth } : {}), ...(form.contactInfo ? { contactInfo: form.contactInfo.trim() } : {}) } }, { onSuccess: onSession, onError: (error) => setFeedback(errText(error)) });
    }
  };
  const flipMode = (next: 'login' | 'register') => { setMode(next); setFeedback(''); setLocation(next === 'login' ? '/login' : '/register'); };
  return <div className="login-page">
    <aside className="login-aside">
      <div className="brand"><span className="brand-mark"><HeartPulse size={20}/></span>medichain</div>
      <div className="aside-copy"><p className="eyebrow">Care, connected</p><h1>Your health story, in safe hands.</h1><p>Keep your records close, share them on your terms, and help your care team see what matters.</p></div>
      <div className="aside-foot">Private by design · Built for patients and clinicians</div>
    </aside>
    <main className="login-main">
      <div className="auth-card">
        <div className="mobile-brand"><span className="brand-mark"><HeartPulse size={18}/></span>medichain</div>
        <div className="auth-tabs"><button className={`auth-tab ${mode === 'login' ? 'active' : ''}`} onClick={() => flipMode('login')} data-testid="tab-login">Sign in</button><button className={`auth-tab ${mode === 'register' ? 'active' : ''}`} onClick={() => flipMode('register')} data-testid="tab-register">Create account</button></div>
        <h2>{mode === 'login' ? 'Welcome back' : 'Start your record'}</h2><p>{mode === 'login' ? 'Sign in to continue to your secure care workspace.' : 'Create a trusted account for your care journey.'}</p>
        {feedback && <div className="error-state" role="alert"><span>{feedback}</span><AlertCircle size={17}/></div>}
        <form onSubmit={submit}>
          {mode === 'register' && <>
            <div className="field"><label htmlFor="auth-name">Full name</label><input id="auth-name" value={form.name} onChange={onField('name')} required minLength={2} autoComplete="name" data-testid="input-name" placeholder="Your name"/></div>
            <div className="field"><label>Account type</label><div className="role-choice"><button type="button" className={`role-option ${role === 'PATIENT' ? 'selected' : ''}`} onClick={() => setRole('PATIENT')} data-testid="role-patient"><UserRound size={15}/> Patient</button><button type="button" className={`role-option ${role === 'DOCTOR' ? 'selected' : ''}`} onClick={() => setRole('DOCTOR')} data-testid="role-doctor"><Stethoscope size={15}/> Doctor</button></div></div>
            <div className="field"><label htmlFor="auth-dob">Date of birth <span className="field-note">Optional</span></label><input type="date" id="auth-dob" value={form.dateOfBirth} onChange={onField('dateOfBirth')} data-testid="input-dob"/></div>
            <div className="field"><label htmlFor="auth-contact">Contact information <span className="field-note">Optional</span></label><input id="auth-contact" value={form.contactInfo} onChange={onField('contactInfo')} data-testid="input-contact" placeholder="Phone number"/></div>
          </>}
          <div className="field"><label htmlFor="auth-email">Email address</label><input id="auth-email" type="email" value={form.email} onChange={onField('email')} required autoComplete="email" data-testid="input-email" placeholder="you@example.com"/></div>
          <div className="field"><label htmlFor="auth-password">Password</label><input id="auth-password" type="password" value={form.password} onChange={onField('password')} required minLength={mode === 'register' ? 8 : 1} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} data-testid="input-password" placeholder={mode === 'register' ? 'At least 8 characters' : 'Your password'}/></div>
          <button className="btn auth-submit" type="submit" disabled={busy} data-testid="button-auth-submit">{busy ? 'Please wait…' : mode === 'login' ? <>Sign in <ArrowRight size={15}/></> : <>Create account <ArrowRight size={15}/></>}</button>
        </form>
        <div className="auth-foot"><LockKeyhole size={12}/> Your health information is private and protected. Doctor accounts may require approval.</div>
      </div>
    </main>
  </div>;
}

function Workspace({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const [tab, setTab] = useState<Tab>(user.role === 'ADMIN' ? 'System overview' : user.role === 'DOCTOR' || user.role === 'PENDING_DOCTOR' ? 'Patients' : 'Overview');
  const tabs = user.role === 'ADMIN' ? adminTabs : user.role === 'DOCTOR' || user.role === 'PENDING_DOCTOR' ? doctorTabs : patientTabs;
  const base = user.role === 'ADMIN' ? '/admin' : user.role === 'DOCTOR' || user.role === 'PENDING_DOCTOR' ? '/doctor' : '/patient';
  const [, setLocation] = useLocation();
  useEffect(() => { setLocation(base); }, [base, setLocation]);
  const iconFor: Record<string, typeof HeartPulse> = {
    Overview: Activity, Records: FileHeart, 'Access control': KeyRound, 'Emergency info': HeartPulse,
    Patients: Search, 'Record entry': FilePlus2, Profile: UserRound, 'System overview': Activity,
    'Doctor approvals': BadgeCheck, 'User search': Users, Analytics: ClipboardList,
  };
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><HeartPulse size={19}/></span>medichain</div>
      <div className="nav-label">Workspace</div>
      <nav className="nav-list" aria-label="Main navigation">{tabs.map((item) => { const Icon = iconFor[item]; return <button key={item} className={`nav-item ${tab === item ? 'active' : ''}`} onClick={() => setTab(item)} data-testid={`nav-${item.toLowerCase().replaceAll(' ', '-')}`}><Icon size={16}/><span>{item}</span></button>; })}</nav>
      <div className="sidebar-bottom"><div className="privacy-note"><b><ShieldCheck size={14} style={{verticalAlign:'-3px',marginRight:6}}/>Your care stays yours</b>Access is granted by you and can be changed at any time.</div><div className="profile-mini"><div className="avatar">{initials(user.name)}</div><div style={{flex:1,minWidth:0}}><strong>{user.name}</strong><span>{user.role === 'PENDING_DOCTOR' ? 'Doctor · pending review' : user.role.toLowerCase()}</span></div><button className="icon-button" onClick={onSignOut} aria-label="Sign out" data-testid="button-signout"><LogOut size={15}/></button></div></div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div className="crumb"><span>Medichain</span><ChevronRight size={13}/><strong>{tab}</strong></div><div className="top-actions"><span className="status-pill"><i className="status-dot"/> Secure workspace</span><button className="icon-button" aria-label="Sign out" onClick={onSignOut} data-testid="button-signout-top"><LogOut size={15}/></button></div></header>
      {user.role === 'ADMIN' ? <AdminView user={user} tab={tab} onTab={setTab}/> : user.role === 'DOCTOR' || user.role === 'PENDING_DOCTOR' ? <DoctorView user={user} tab={tab}/> : <PatientView user={user} tab={tab} onTab={setTab}/>}
    </main>
  </div>;
}

function Heading({ eyebrow, title, subtitle, action }: { eyebrow: string; title: string; subtitle: string; action?: ReactNode }) {
  return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="subhead">{subtitle}</p></div>{action}</div>;
}
function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return <div className="error-state" role="alert"><span>{errText(error)}</span>{retry && <button className="btn small ghost" onClick={retry}>Try again</button>}</div>;
}
function EmptyState({ icon: Icon = BookOpen, title, children }: { icon?: typeof BookOpen; title: string; children: string }) {
  return <div className="empty-state"><span className="empty-icon"><Icon size={19}/></span><strong>{title}</strong><p>{children}</p></div>;
}
function Stat({ label, value, note, icon: Icon }: { label: string; value: string | number; note: string; icon: typeof Activity }) {
  return <article className="panel stat-card" data-testid={`stat-${label.toLowerCase().replaceAll(' ','-')}`}><Icon size={18} className="stat-icon"/><span className="stat-label">{label}</span><div className="stat-value">{value}</div><span className="stat-foot">{note}</span></article>;
}

function PatientView({ user, tab, onTab }: { user: User; tab: Tab; onTab: (tab: Tab) => void }) {
  const profile = useGetPatientProfile();
  const records = useGetPatientRecords();
  const permissions = useGetPatientPermissions();
  const requests = useGetPatientPendingRequests();
  const qc = useQueryClient();
  const [grantOpen, setGrantOpen] = useState(false);
  const [grantEmail, setGrantEmail] = useState('');
  const [grantDays, setGrantDays] = useState('30');
  const [toast, setToast] = useState('');
  const grant = useGrantPatientPermission();
  const revoke = useRevokePatientPermission();
  const updateEmergency = useUpdateEmergencyInfo();
  const emergency = profile.data?.emergencyInfo;
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getGetPatientProfileQueryKey() });
    qc.invalidateQueries({ queryKey: getGetPatientPermissionsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetPatientPendingRequestsQueryKey() });
  };
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 3000); };
  const submitGrant = (event: FormEvent) => {
    event.preventDefault();
    grant.mutate({ data: { doctorEmail: grantEmail.trim(), durationDays: Number(grantDays) } }, { onSuccess: () => { invalidate(); setGrantOpen(false); setGrantEmail(''); notify('Access updated.'); }, onError: (e) => notify(errText(e)) });
  };
  const revokeDoctor = (doctorId: number) => {
    if (!window.confirm('Remove this doctor’s access to your records?')) return;
    revoke.mutate({ doctorId }, { onSuccess: () => { invalidate(); notify('Doctor access removed.'); }, onError: (e) => notify(errText(e)) });
  };
  const updateEmergencySubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const payload: EmergencyInfoInput = {
      bloodGroup: String(values.get('bloodGroup')) as EmergencyInfoInput['bloodGroup'],
      weightKg: Number(values.get('weightKg')), heightCm: Number(values.get('heightCm')),
      allergies: String(values.get('allergies') || ''), emergencyContact: String(values.get('emergencyContact') || ''),
    };
    updateEmergency.mutate({ data: payload }, { onSuccess: () => { invalidate(); notify('Emergency information saved.'); }, onError: (e) => notify(errText(e)) });
  };
  return <>
    {tab === 'Overview' && <>
      <Heading eyebrow="Patient workspace" title={`Good to see you, ${user.name.split(' ')[0]}.`} subtitle="Your records, shared care and important health details — all together." action={<button className="btn secondary" onClick={() => { onTab('Emergency info'); }} data-testid="button-emergency"><HeartPulse size={15}/> Emergency info</button>}/>
      {profile.isLoading ? <div className="grid stats-grid">{[1,2,3,4].map((n)=><div className="skeleton" key={n}/>)}</div> : profile.error ? <ErrorState error={profile.error} retry={() => profile.refetch()}/> : <>
        <div className="grid stats-grid"><Stat label="Medical records" value={profile.data?.recordCount ?? 0} note="Records in your secure file" icon={FileHeart}/><Stat label="Doctors with access" value={profile.data?.permissionsCount ?? 0} note="You control every connection" icon={Users}/><Stat label="Date of birth" value={user.dateOfBirth ? new Date(user.dateOfBirth).toLocaleDateString(undefined,{month:'short',day:'numeric'}) : '—'} note={user.dateOfBirth ? dateLabel(user.dateOfBirth) : 'Add details to your profile'} icon={CalendarDays}/><Stat label="Emergency details" value={emergency ? 'Ready' : 'Add now'} note={emergency ? 'Available to your care team' : 'Help clinicians act with confidence'} icon={HeartPulse}/></div>
        <div className="grid dashboard-grid"><section className="panel"><div className="panel-head"><div><h2 className="panel-title">Recent records</h2><p className="panel-caption">A view of your latest care history</p></div><button className="btn ghost small" onClick={()=>onTab('Records')} data-testid="button-all-records">All records <ArrowRight size={13}/></button></div><div className="panel-body">{records.isLoading ? <div className="skeleton"/> : records.error ? <ErrorState error={records.error} retry={()=>records.refetch()}/> : records.data?.length ? records.data.slice(0,4).map((record)=><RecordRow key={record.id} record={record}/>) : <EmptyState icon={FileHeart} title="Your record begins here" children="When a clinician adds a visit or result, it will appear in this timeline."/>}</div></section>
          <section className="panel"><div className="panel-head"><div><h2 className="panel-title">Care essentials</h2><p className="panel-caption">Useful in a moment that matters</p></div><Shield size={17} color="#69a293"/></div><div className="panel-body"><div className="callout"><div className="callout-head"><HeartPulse size={16}/> Emergency summary</div><p>{emergency ? `${emergency.bloodGroup} blood group · ${emergency.allergies ? `Allergies: ${emergency.allergies}` : 'No allergies listed'}` : 'Add your blood group, allergies and an emergency contact.'}</p><button className="btn small secondary" onClick={()=>onTab('Emergency info')} data-testid="button-update-emergency">Review details <ArrowRight size={13}/></button></div><div style={{height:15}}/><div className="data-row"><span className="data-key">Contact</span><span className="data-value">{user.contactInfo || 'Not provided'}</span></div><div className="data-row"><span className="data-key">Pending requests</span><span className="data-value">{requests.data?.length ?? '—'}</span></div></div></section></div>
      </>}
    </>}
    {tab === 'Records' && <><Heading eyebrow="Your health history" title="Medical records" subtitle="Visits, diagnoses, prescriptions and test results shared with your care team." action={<button className="btn secondary" onClick={()=>window.print()} data-testid="button-print-records"><Printer size={15}/> Print booklet</button>}/><section className="panel"><div className="panel-head"><div><h2 className="panel-title">Your record timeline</h2><p className="panel-caption">Newest records appear first. Use Print booklet to save a PDF.</p></div><span className="tag">{records.data?.length ?? 0} records</span></div><div className="panel-body">{records.isLoading ? <div className="skeleton"/> : records.error ? <ErrorState error={records.error} retry={()=>records.refetch()}/> : records.data?.length ? records.data.map((record)=><RecordRow key={record.id} record={record} expanded/>) : <EmptyState icon={FileHeart} title="No records yet" children="Your medical records will appear here when a clinician adds them to your care history."/>}</div></section></>}
    {tab === 'Access control' && <><Heading eyebrow="Your permissions" title="Who can see your records?" subtitle="Grant access to a clinician, choose how long it lasts, or remove access at any time." action={<button className="btn" onClick={()=>setGrantOpen(true)} data-testid="button-grant-access"><Plus size={15}/> Grant access</button>}/>
      <div className="security-banner"><div><h3>You’re in control of your care circle.</h3><p>Clinicians can view your information only while access is active. You can revoke it whenever you need.</p></div><ShieldCheck size={34} className="security-symbol"/></div>
      {requests.isLoading || permissions.isLoading ? <div className="skeleton"/> : requests.error ? <ErrorState error={requests.error} retry={()=>requests.refetch()}/> : permissions.error ? <ErrorState error={permissions.error} retry={()=>permissions.refetch()}/> : <>
        <section className="panel" style={{marginBottom:17}}><div className="panel-head"><div><h2 className="panel-title">Clinician requests</h2><p className="panel-caption">A doctor searched for your care profile</p></div><span className="tag warning">{requests.data?.length ?? 0} pending</span></div><div className="panel-body">{requests.data?.length ? requests.data.map((request)=><div className="data-row" key={`${request.doctorId}-${request.searchedAt}`}><div className="person-cell"><div className="avatar">{initials(request.doctorName)}</div><span>{request.doctorName}<small style={{display:'block',fontWeight:400,color:'#92a09a',marginTop:3}}>{request.doctorEmail} · {dateLabel(request.searchedAt)}</small></span></div><button className="btn small secondary" onClick={()=>{setGrantEmail(request.doctorEmail);setGrantOpen(true);}} data-testid={`button-review-request-${request.doctorId}`}>Review access</button></div>) : <EmptyState icon={KeyRound} title="No requests to review" children="When a doctor asks to see your profile, you can decide whether to grant access here."/>}</div></section>
        <section className="panel"><div className="panel-head"><div><h2 className="panel-title">Your active access</h2><p className="panel-caption">Only approved clinicians can see your records</p></div></div><div className="panel-body">{permissions.data?.filter(p=>p.granted).length ? permissions.data.filter(p=>p.granted).map((permission)=><div className="data-row" key={permission.id}><div className="person-cell"><div className="avatar">{initials(permission.doctorName)}</div><span>{permission.doctorName}<small style={{display:'block',fontWeight:400,color:'#92a09a',marginTop:3}}>{permission.doctorEmail}</small></span></div><span className="tag">Until {dateLabel(permission.expiresAt)}</span><button className="btn small ghost" disabled={revoke.isPending} onClick={()=>revokeDoctor(permission.doctorId)} data-testid={`button-revoke-${permission.doctorId}`}><Trash2 size={13}/> Revoke</button></div>) : <EmptyState icon={Shield} title="No clinicians have access" children="Grant access by entering a doctor's registered email address."/>}</div></section>
      </>}
      {grantOpen && <Modal title="Grant a doctor access" onClose={()=>setGrantOpen(false)}><p className="subhead" style={{margin:'0 0 18px'}}>Choose a clinician and duration. They must have a verified Medichain doctor account.</p><form onSubmit={submitGrant}><div className="field"><label htmlFor="grant-email">Doctor’s email</label><input id="grant-email" type="email" required value={grantEmail} onChange={e=>setGrantEmail(e.target.value)} data-testid="input-doctor-email" placeholder="doctor@clinic.org"/></div><div className="field" style={{marginTop:14}}><label htmlFor="grant-duration">Access duration</label><select id="grant-duration" value={grantDays} onChange={e=>setGrantDays(e.target.value)} data-testid="select-duration"><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="180">180 days</option><option value="365">1 year</option></select></div><div className="form-actions"><button className="btn ghost" type="button" onClick={()=>setGrantOpen(false)}>Cancel</button><button className="btn" type="submit" disabled={grant.isPending} data-testid="button-confirm-grant">{grant.isPending?'Saving…':'Grant access'}</button></div></form></Modal>}
    </>}
    {tab === 'Emergency info' && <><Heading eyebrow="Critical care details" title="Emergency information" subtitle="Keep important details current. Approved doctors can use this information to act quickly." action={<button className="btn secondary" onClick={()=>window.print()} data-testid="button-print-emergency"><Printer size={15}/> Print summary</button>}/><div className="security-banner"><div><h3>Made for the moments that matter.</h3><p>This concise summary supports safer urgent care when you cannot speak for yourself.</p></div><HeartPulse size={34} className="security-symbol"/></div>
      {profile.isLoading ? <div className="skeleton"/> : profile.error ? <ErrorState error={profile.error} retry={()=>profile.refetch()}/> : <section className="panel"><div className="panel-head"><div><h2 className="panel-title">Your emergency card</h2><p className="panel-caption">{emergency ? `Last updated ${dateLabel(emergency.updatedAt)}` : 'No details saved yet'}</p></div><span className="tag">{user.name}</span></div><div className="panel-body"><form onSubmit={updateEmergencySubmit}><div className="form-grid"><div className="field"><label htmlFor="blood-group">Blood group</label><select id="blood-group" name="bloodGroup" defaultValue={emergency?.bloodGroup || 'Unknown'} data-testid="select-blood-group">{['A+','A-','B+','B-','AB+','AB-','O+','O-','Unknown'].map(g=><option value={g} key={g}>{g}</option>)}</select></div><div className="field"><label htmlFor="weight">Weight (kg)</label><input id="weight" name="weightKg" type="number" min="1" max="500" step="0.1" defaultValue={emergency?.weightKg ?? ''} required data-testid="input-weight"/></div><div className="field"><label htmlFor="height">Height (cm)</label><input id="height" name="heightCm" type="number" min="30" max="260" step="0.1" defaultValue={emergency?.heightCm ?? ''} required data-testid="input-height"/></div><div className="field"><label htmlFor="emergency-contact">Emergency contact</label><input id="emergency-contact" name="emergencyContact" defaultValue={emergency?.emergencyContact ?? ''} required maxLength={300} data-testid="input-emergency-contact" placeholder="Name and phone number"/></div><div className="field full"><label htmlFor="allergies">Allergies and critical notes</label><textarea id="allergies" name="allergies" defaultValue={emergency?.allergies ?? ''} maxLength={2000} data-testid="input-allergies" placeholder="List allergies, reactions, or important information. Write “None known” if applicable."/></div></div><div className="form-actions"><button className="btn" type="submit" disabled={updateEmergency.isPending} data-testid="button-save-emergency">{updateEmergency.isPending?'Saving…':<><Check size={15}/> Save emergency info</>}</button></div></form></div></section>}</>}
    {toast && <div className="toast-message" role="status">{toast}</div>}
  </>;
}

function RecordRow({ record, expanded = false }: { record: import('@workspace/api-client-react').MedicalRecord; expanded?: boolean }) {
  return <article className="record-row" data-testid={`record-${record.id}`}><span className="record-icon"><FileHeart size={17}/></span><div className="record-main"><strong>{record.recordType} <span style={{fontWeight:500,color:'#81908b'}}>· {record.doctorName}</span></strong><p><b>{record.diagnosis || 'Care note'}</b>{record.treatment ? ` — ${record.treatment}` : ''}</p>{expanded && <><p>{record.notes}</p>{record.medications.length > 0 && <p>Medications: {record.medications.join(', ')}</p>}{record.vitals && <p>Vitals: {[record.vitals.bloodPressure && `BP ${record.vitals.bloodPressure}`,record.vitals.heartRate && `HR ${record.vitals.heartRate}`,record.vitals.temperature && `${record.vitals.temperature}°C`,record.vitals.weightKg && `${record.vitals.weightKg} kg`].filter(Boolean).join(' · ') || 'Not recorded'}</p>}</>}</div><time className="record-meta">{dateLabel(record.createdAt)}</time></article>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <div role="presentation" onMouseDown={(e)=>{if(e.target===e.currentTarget)onClose();}} style={{position:'fixed',inset:0,zIndex:50,background:'#17343580',display:'flex',alignItems:'center',justifyContent:'center',overflowY:'auto',padding:16}}><section role="dialog" aria-modal="true" aria-label={title} className="panel" style={{width:'min(100%,440px)',maxHeight:'calc(100dvh - 32px)',display:'flex',flexDirection:'column',padding:0,overflow:'hidden',boxShadow:'0 22px 70px #17343540'}}><div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,padding:'20px 23px 12px',flexShrink:0}}><h2 className="panel-title">{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={16}/></button></div><div style={{padding:'4px 23px 23px',overflowY:'auto',minHeight:0,overscrollBehavior:'contain'}}>{children}</div></section></div>;
}

function DoctorView({ user, tab }: { user: User; tab: Tab }) {
  const [search, setSearch] = useState('');
  const [patientId, setPatientId] = useState<number | null>(null);
  const [entryOpen, setEntryOpen] = useState(false);
  const [toast, setToast] = useState('');
  const activeDoctor = user.role === 'DOCTOR';
  const profile = useGetDoctorProfile({ query: { enabled: activeDoctor, queryKey: getGetDoctorProfileQueryKey() } });
  const stats = useGetDoctorStats({ query: { enabled: activeDoctor, queryKey: getGetDoctorStatsQueryKey() } });
  const params = useMemo(() => ({ query: search.trim().length >= 2 ? search.trim() : '__' }), [search]);
  const searchResults = useSearchPatients(params, { query: { enabled: search.trim().length >= 2, queryKey: getSearchPatientsQueryKey(params), retry: false } });
  const emergency = useGetPatientEmergency(patientId ?? 0, { query: { enabled: patientId !== null, queryKey: getGetPatientEmergencyQueryKey(patientId ?? 0), retry: false } });
  const patientRecords = useGetDoctorPatientRecords(patientId ?? 0, { query: { enabled: patientId !== null, queryKey: getGetDoctorPatientRecordsQueryKey(patientId ?? 0), retry: false } });
  const addRecord = useAddDoctorPatientRecord();
  const qc = useQueryClient();
  const selected = searchResults.data?.find((result) => result.user.id === patientId);
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 3000); };
  const submitRecord = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (patientId === null) return;
    const form = new FormData(event.currentTarget);
    const numOrNull = (key: string) => String(form.get(key) || '').trim() ? Number(form.get(key)) : null;
    const payload: MedicalRecordInput = {
      recordType: String(form.get('recordType')) as MedicalRecordRecordType,
      diagnosis: String(form.get('diagnosis') || ''),
      treatment: String(form.get('treatment') || ''),
      medications: String(form.get('medications') || '').split(',').map((item) => item.trim()).filter(Boolean),
      notes: String(form.get('notes') || ''),
      vitals: {
        bloodPressure: String(form.get('bloodPressure') || '').trim() || null,
        heartRate: numOrNull('heartRate'), temperature: numOrNull('temperature'), weightKg: numOrNull('weightKg'),
      },
    };
    addRecord.mutate({ patientId, data: payload }, { onSuccess: () => {
      qc.invalidateQueries({ queryKey: getGetDoctorPatientRecordsQueryKey(patientId) });
      qc.invalidateQueries({ queryKey: getGetDoctorStatsQueryKey() });
      setEntryOpen(false); notify('Record added to the patient file.');
    }, onError: (error) => notify(errText(error)) });
  };
  const choosePatient = (id: number) => { setPatientId(id); setEntryOpen(false); };
  if (user.role === 'PENDING_DOCTOR') return <><Heading eyebrow="Clinician access" title={`Welcome, Dr. ${user.name}.`} subtitle="Your account is under review. Once approved, you can search for patients and contribute to their records."/><div className="security-banner"><div><h3>Verification in progress</h3><p>Our administrative team is reviewing your account details. You’ll be able to use the clinical workspace after approval.</p></div><Clock3 size={33} className="security-symbol"/></div><section className="panel"><div className="panel-head"><div><h2 className="panel-title">Account profile</h2><p className="panel-caption">Information submitted with your registration</p></div><span className="tag warning">Pending review</span></div><div className="panel-body"><div className="data-row"><span className="data-key">Name</span><span className="data-value">{user.name}</span></div><div className="data-row"><span className="data-key">Email</span><span className="data-value">{user.email}</span></div><div className="data-row"><span className="data-key">Submitted</span><span className="data-value">{dateLabel(user.createdAt)}</span></div></div></section></>;
  return <>
    {tab === 'Patients' && <>
      <Heading eyebrow="Clinical workspace" title="Patient search" subtitle="Find a patient and act on the information they have chosen to share."/>
      <div className="security-banner"><div><h3>Care begins with consent.</h3><p>Search for a patient to view the emergency information available to you. Full records require their permission.</p></div><ShieldCheck size={33} className="security-symbol"/></div>
      <div className="searchbox" style={{marginBottom:18,width:'min(100%,550px)'}}><Search size={16} color="#81918c"/><input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search by patient name or email" data-testid="input-patient-search"/></div>
      {search.trim().length < 2 ? <section className="panel"><EmptyState icon={Search} title="Search for a patient" children="Enter at least two characters to find a patient by name or email." /></section> : searchResults.isLoading ? <div className="skeleton"/> : searchResults.error ? <ErrorState error={searchResults.error} retry={()=>searchResults.refetch()}/> : !searchResults.data?.length ? <section className="panel"><EmptyState icon={Users} title="No patients found" children="Check the spelling or try searching with a different name or email." /></section> :
        <section className="panel"><div className="panel-head"><div><h2 className="panel-title">Search results</h2><p className="panel-caption">{searchResults.data.length} patient{searchResults.data.length===1?'':'s'} found</p></div></div><div className="panel-body">{searchResults.data.map((result)=><div key={result.user.id} className="data-row"><div className="person-cell"><div className="avatar">{initials(result.user.name)}</div><span>{result.user.name}<small style={{display:'block',fontWeight:400,color:'#92a09a',marginTop:3}}>{result.user.email}</small></span></div><span className={result.hasAccess?'tag':'tag warning'}>{result.hasAccess?'Records available':'Emergency only'}</span><button className="btn small secondary" onClick={()=>choosePatient(result.user.id)} data-testid={`button-view-patient-${result.user.id}`}>Open patient <ArrowRight size={13}/></button></div>)}</div></section>}
      {selected && <section className="panel" style={{marginTop:19}}><div className="panel-head"><div><h2 className="panel-title">{selected.user.name}</h2><p className="panel-caption">{selected.user.email} · Patient since {dateLabel(selected.user.createdAt)}</p></div><button className="icon-button" onClick={()=>setPatientId(null)} aria-label="Close patient details"><X size={15}/></button></div><div className="panel-body">
        {emergency.isLoading ? <div className="skeleton"/> : emergency.error ? <ErrorState error={emergency.error} retry={()=>emergency.refetch()}/> : emergency.data ? <div className="callout" style={{marginBottom:15}}><div className="callout-head"><HeartPulse size={16}/> Emergency information</div><div className="data-row"><span className="data-key">Blood group</span><span className="data-value">{emergency.data.bloodGroup}</span></div><div className="data-row"><span className="data-key">Allergies</span><span className="data-value">{emergency.data.allergies || 'None listed'}</span></div><div className="data-row"><span className="data-key">Emergency contact</span><span className="data-value">{emergency.data.emergencyContact || 'Not provided'}</span></div><div className="data-row"><span className="data-key">Updated</span><span className="data-value">{dateLabel(emergency.data.updatedAt)}</span></div></div> : <EmptyState icon={HeartPulse} title="Emergency information unavailable" children="This patient has not added emergency details yet."/>}
        {selected.hasAccess ? <><div style={{display:'flex',justifyContent:'space-between',alignItems:'center',margin:'20px 0 10px'}}><div><h3 className="panel-title">Shared medical records</h3><p className="panel-caption">Access expires {dateLabel(selected.expiresAt)}</p></div><button className="btn small" onClick={()=>setEntryOpen(true)} data-testid="button-add-record"><Plus size={14}/> Add record</button></div>{patientRecords.isLoading ? <div className="skeleton"/> : patientRecords.error ? <ErrorState error={patientRecords.error} retry={()=>patientRecords.refetch()}/> : patientRecords.data?.length ? patientRecords.data.map(r=><RecordRow key={r.id} record={r} expanded/>) : <EmptyState icon={FileHeart} title="No shared records yet" children="Add a consultation or other record to begin this patient’s shared timeline."/>}</> : <div className="notice" style={{marginTop:18}}>Full medical records are private until this patient grants you access. You can view only emergency information for now.</div>}
      </div></section>}
      {entryOpen && selected?.hasAccess && <Modal title={`Add a record for ${selected.user.name}`} onClose={()=>setEntryOpen(false)}><form onSubmit={submitRecord}><div className="form-grid"><div className="field"><label htmlFor="record-type">Record type</label><select id="record-type" name="recordType" data-testid="select-record-type">{['Consultation','Diagnosis','Treatment','Lab Results','Prescription','Surgery','Emergency','Follow-up','Other'].map((t)=><option key={t}>{t}</option>)}</select></div><div className="field"><label htmlFor="record-diagnosis">Diagnosis</label><input id="record-diagnosis" name="diagnosis" required maxLength={5000} data-testid="input-diagnosis"/></div><div className="field full"><label htmlFor="record-treatment">Treatment / plan</label><textarea id="record-treatment" name="treatment" maxLength={5000} data-testid="input-treatment"/></div><div className="field full"><label htmlFor="record-meds">Medications</label><input id="record-meds" name="medications" placeholder="Separate medications with commas" data-testid="input-medications"/></div><div className="field"><label htmlFor="record-bp">Blood pressure</label><input id="record-bp" name="bloodPressure" placeholder="120/80" data-testid="input-vital-bp"/></div><div className="field"><label htmlFor="record-hr">Heart rate (bpm)</label><input id="record-hr" name="heartRate" type="number" min="30" max="200" data-testid="input-vital-heart-rate"/></div><div className="field"><label htmlFor="record-temp">Temperature (°C)</label><input id="record-temp" name="temperature" type="number" step=".1" min="30" max="45" data-testid="input-vital-temp"/></div><div className="field"><label htmlFor="record-weight">Weight (kg)</label><input id="record-weight" name="weightKg" type="number" step=".1" min="1" max="500" data-testid="input-vital-weight"/></div><div className="field full"><label htmlFor="record-notes">Clinical notes</label><textarea id="record-notes" name="notes" maxLength={10000} data-testid="input-record-notes"/></div></div><div className="form-actions"><button className="btn ghost" type="button" onClick={()=>setEntryOpen(false)}>Cancel</button><button className="btn" type="submit" disabled={addRecord.isPending} data-testid="button-save-record">{addRecord.isPending?'Saving…':'Save record'}</button></div></form></Modal>}
    </>}
    {tab === 'Record entry' && <><Heading eyebrow="Clinical notes" title="Record entry" subtitle="Choose a patient with active access, then add a clear, useful care note."/><section className="panel"><div className="panel-head"><div><h2 className="panel-title">Select a patient</h2><p className="panel-caption">Search patients first to confirm their record-sharing permission.</p></div></div><div className="panel-body"><div className="searchbox"><Search size={15} color="#81918c"/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Patient name or email" data-testid="input-entry-patient-search"/></div>{search.trim().length>=2 && (searchResults.isLoading?<div className="skeleton" style={{marginTop:15}}/>:searchResults.error?<ErrorState error={searchResults.error} retry={()=>searchResults.refetch()}/>:searchResults.data?.filter(r=>r.hasAccess).map(r=><div className="data-row" key={r.user.id}><div className="person-cell"><div className="avatar">{initials(r.user.name)}</div><span>{r.user.name}<small style={{display:'block',fontWeight:400,color:'#92a09a',marginTop:3}}>{r.user.email}</small></span></div><span className="tag">Access active</span><button className="btn small" onClick={()=>{choosePatient(r.user.id);setEntryOpen(true);}} data-testid={`button-create-record-${r.user.id}`}><FilePlus2 size={13}/> New record</button></div>))}{search.trim().length>=2 && !searchResults.isLoading && !searchResults.error && !searchResults.data?.some(r=>r.hasAccess) && <EmptyState icon={KeyRound} title="No active access found" children="The patient needs to grant you permission before you can add a record."/>}</div></section></>}
    {tab === 'Profile' && <><Heading eyebrow="Clinician account" title="Your profile" subtitle="Your account identity for patients and the Medichain care network."/><div className="grid dashboard-grid"><section className="panel"><div className="panel-head"><div><h2 className="panel-title">Professional profile</h2><p className="panel-caption">Registered account information</p></div><div className="avatar">{initials(profile.data?.name || user.name)}</div></div><div className="panel-body">{profile.isLoading?<div className="skeleton"/>:profile.error?<ErrorState error={profile.error} retry={()=>profile.refetch()}/>:<><div className="data-row"><span className="data-key">Name</span><span className="data-value">{profile.data?.name}</span></div><div className="data-row"><span className="data-key">Email address</span><span className="data-value">{profile.data?.email}</span></div><div className="data-row"><span className="data-key">Account status</span><span className="data-value"><span className="tag">{profile.data?.status}</span></span></div><div className="data-row"><span className="data-key">Member since</span><span className="data-value">{dateLabel(profile.data?.createdAt)}</span></div><div className="data-row"><span className="data-key">Contact</span><span className="data-value">{profile.data?.contactInfo || 'Not provided'}</span></div></>}</div></section><section className="panel"><div className="panel-head"><div><h2 className="panel-title">Your impact</h2><p className="panel-caption">Stats from your clinical activity</p></div></div><div className="panel-body">{stats.isLoading?<div className="skeleton"/>:stats.error?<ErrorState error={stats.error} retry={()=>stats.refetch()}/>:<><div className="data-row"><span className="data-key">Patients treated</span><span className="data-value">{stats.data?.patientsTreated ?? 0}</span></div><div className="data-row"><span className="data-key">Records added</span><span className="data-value">{stats.data?.recordsAdded ?? 0}</span></div><div className="data-row"><span className="data-key">This month</span><span className="data-value">{stats.data?.recordsThisMonth ?? 0}</span></div></>}</div></section></div></>}
    {toast && <div className="toast-message" role="status">{toast}</div>}
  </>;
}

function AdminView({ user, tab, onTab }: { user: User; tab: Tab; onTab: (tab: Tab) => void }) {
  const [doctorQuery, setDoctorQuery] = useState('');
  const [userQuery, setUserQuery] = useState('');
  const qc = useQueryClient();
  const stats = useGetAdminStats();
  const analytics = useGetAdminAnalytics();
  const pending = useGetPendingDoctors();
  const doctorParams = useMemo(()=>({query:doctorQuery.trim().length>=2?doctorQuery.trim():'__'}),[doctorQuery]);
  const userParams = useMemo(()=>({query:userQuery.trim().length>=2?userQuery.trim():'__'}),[userQuery]);
  const doctorSearch = useSearchUsers(doctorParams,{query:{enabled:tab==='Doctor approvals'&&doctorQuery.trim().length>=2,queryKey:getSearchUsersQueryKey(doctorParams),retry:false}});
  const userSearch = useSearchUsers(userParams,{query:{enabled:tab==='User search'&&userQuery.trim().length>=2,queryKey:getSearchUsersQueryKey(userParams),retry:false}});
  const approve = useApproveDoctor();
  const revoke = useRevokeDoctor();
  const [toast, setToast] = useState('');
  const notify = (message: string) => { setToast(message); window.setTimeout(()=>setToast(''),3000); };
  const refresh = () => {
    qc.invalidateQueries({queryKey:getGetPendingDoctorsQueryKey()});
    qc.invalidateQueries({queryKey:getGetAdminStatsQueryKey()});
    qc.invalidateQueries({queryKey:getGetAdminAnalyticsQueryKey()});
    qc.invalidateQueries({queryKey:getSearchUsersQueryKey()});
  };
  const approveOne = (id:number) => approve.mutate({doctorId:id},{onSuccess:()=>{refresh();notify('Doctor account approved.')},onError:e=>notify(errText(e))});
  const revokeOne = (id:number) => {
    if(!window.confirm('Revoke this doctor’s Medichain access?')) return;
    revoke.mutate({doctorId:id},{onSuccess:()=>{refresh();notify('Doctor account revoked.')},onError:e=>notify(errText(e))});
  };
  const displayStats = analytics.data?.stats ?? stats.data;
  return <>
    {tab==='System overview' && <><Heading eyebrow="Administration" title={`Good morning, ${user.name.split(' ')[0]}.`} subtitle="A clear view of the care network and the system’s operational health."/>
      {stats.isLoading||analytics.isLoading?<div className="grid stats-grid">{[1,2,3,4].map(n=><div className="skeleton" key={n}/>)}</div>:stats.error||analytics.error?<ErrorState error={stats.error||analytics.error} retry={()=>{stats.refetch();analytics.refetch()}}/>:<>
        <div className="grid stats-grid"><Stat label="Patients" value={displayStats?.totalPatients??0} note="Registered patient accounts" icon={Users}/><Stat label="Active doctors" value={displayStats?.activeDoctors??0} note="Approved clinical accounts" icon={Stethoscope}/><Stat label="Pending approvals" value={displayStats?.pendingDoctors??0} note="Clinician accounts to review" icon={Clock3}/><Stat label="Consultations" value={displayStats?.totalConsultations??0} note="Across the care network" icon={FileHeart}/></div>
        <div className="grid dashboard-grid"><section className="panel"><div className="panel-head"><div><h2 className="panel-title">System health</h2><p className="panel-caption">Current status of essential services</p></div><span className="status-pill"><i className="status-dot"/> Live</span></div><div className="panel-body">{analytics.data?.systemStatus?.length?analytics.data.systemStatus.map((service)=><div className="data-row" key={service.name}><span className="person-cell"><span className="record-icon"><Activity size={15}/></span>{service.name}</span><span className={service.status==='Operational'?'tag':'tag warning'}>{service.status}</span></div>):<EmptyState icon={Activity} title="No status information" children="System status will appear here when available."/ >}</div></section>
          <section className="panel"><div className="panel-head"><div><h2 className="panel-title">Doctor approvals</h2><p className="panel-caption">Keep clinical access appropriately reviewed</p></div><button className="btn small secondary" onClick={()=>onTab('Doctor approvals')} data-testid="button-open-approvals" >Review</button></div><div className="panel-body">{pending.isLoading?<div className="skeleton"/>:pending.error?<ErrorState error={pending.error} retry={()=>pending.refetch()}/>:pending.data?.length?pending.data.slice(0,4).map(d=><div className="data-row" key={d.id}><div className="person-cell"><div className="avatar">{initials(d.name)}</div><span>{d.name}<small style={{display:'block',fontWeight:400,color:'#92a09a',marginTop:3}}>{d.email}</small></span></div><button className="btn small secondary" onClick={()=>approveOne(d.id)} disabled={approve.isPending} data-testid={`button-approve-overview-${d.id}`}><Check size={13}/> Approve</button></div>):<EmptyState icon={BadgeCheck} title="No approvals waiting" children="New clinician registrations will appear here."/>}</div></section></div>
      </>}
    </>}
    {tab==='Doctor approvals' && <><Heading eyebrow="Clinical access" title="Doctor approvals" subtitle="Verify clinician accounts before they can access the patient workspace."/><div className="tabs"><span className="tab active">Pending review</span></div><section className="panel"><div className="panel-head"><div><h2 className="panel-title">Pending clinicians</h2><p className="panel-caption">Approve accounts to enable patient search and care documentation</p></div><span className="tag warning">{pending.data?.length??0} pending</span></div><div className="panel-body">{pending.isLoading?<div className="skeleton"/>:pending.error?<ErrorState error={pending.error} retry={()=>pending.refetch()}/>:pending.data?.length?pending.data.map(d=><div className="data-row" key={d.id}><div className="person-cell"><div className="avatar">{initials(d.name)}</div><span>{d.name}<small style={{display:'block',fontWeight:400,color:'#92a09a',marginTop:3}}>{d.email} · Registered {dateLabel(d.createdAt)}</small></span></div><span className="tag warning">Pending</span><button className="btn small" onClick={()=>approveOne(d.id)} disabled={approve.isPending} data-testid={`button-approve-${d.id}`}><Check size={13}/> Approve</button></div>):<EmptyState icon={BadgeCheck} title="All caught up" children="There are no clinician accounts waiting for review."/>}</div></section>
      <section className="panel" style={{marginTop:18}}><div className="panel-head"><div><h2 className="panel-title">Find a doctor to revoke</h2><p className="panel-caption">Search for an active clinician account</p></div></div><div className="panel-body"><SearchField value={doctorQuery} onChange={setDoctorQuery} placeholder="Doctor name or email" testId="input-doctor-approval-search"/>{doctorQuery.trim().length>=2&&(doctorSearch.isLoading?<div className="skeleton" style={{marginTop:14}}/>:doctorSearch.error?<ErrorState error={doctorSearch.error} retry={()=>doctorSearch.refetch()}/>:doctorSearch.data?.filter(d=>d.role==='DOCTOR').map(d=><UserResult key={d.id} user={d} action={<button className="btn small danger" onClick={()=>revokeOne(d.id)} disabled={revoke.isPending} data-testid={`button-revoke-doctor-${d.id}`}><X size={13}/> Revoke</button>}/>))}</div></section></>}
    {tab==='User search' && <><Heading eyebrow="Network directory" title="User search" subtitle="Find patient and clinician accounts across the Medichain network."/><section className="panel"><div className="panel-head"><div><h2 className="panel-title">Search accounts</h2><p className="panel-caption">Search by name or email address</p></div></div><div className="panel-body"><SearchField value={userQuery} onChange={setUserQuery} placeholder="Name or email" testId="input-user-search"/>{userQuery.trim().length<2?<EmptyState icon={Users} title="Search the network" children="Enter at least two characters to find an account."/>:userSearch.isLoading?<div className="skeleton" style={{marginTop:15}}/>:userSearch.error?<ErrorState error={userSearch.error} retry={()=>userSearch.refetch()}/>:userSearch.data?.length?userSearch.data.map(u=><UserResult key={u.id} user={u} action={u.role==='DOCTOR'?<button className="btn small danger" onClick={()=>revokeOne(u.id)} disabled={revoke.isPending} data-testid={`button-revoke-user-${u.id}`}><X size={13}/> Revoke access</button>:null}/>):<EmptyState icon={Users} title="No matching accounts" children="Try a different spelling or email address."/>}</div></section></>}
    {tab==='Analytics' && <><Heading eyebrow="Network insights" title="Care network analytics" subtitle="Records created across the network and the current system health picture." action={<button className="btn secondary" onClick={()=>window.print()} data-testid="button-print-analytics"><Printer size={15}/> Export report</button>}/>{analytics.isLoading?<div className="skeleton"/>:analytics.error?<ErrorState error={analytics.error} retry={()=>analytics.refetch()}/>:<div className="grid dashboard-grid"><section className="panel"><div className="panel-head"><div><h2 className="panel-title">Records over time</h2><p className="panel-caption">Monthly records added to patient files</p></div></div><div className="panel-body">{analytics.data?.monthlyRecords?.length?<div className="bar-list">{analytics.data.monthlyRecords.map((month,index)=>{const max=Math.max(...analytics.data!.monthlyRecords.map(i=>i.count),1);return <div className="bar-line" key={`${month.month}-${index}`}><span>{month.month}</span><div className="bar-track"><div className="bar-fill" style={{width:`${Math.max(month.count/max*100,2)}%`}}/></div><b style={{textAlign:'right',color:'#58716b'}}>{month.count}</b></div>})}</div>:<EmptyState icon={ClipboardList} title="No analytics to display" children="Monthly record activity will appear here as care records are added."/>}</div></section><section className="panel"><div className="panel-head"><div><h2 className="panel-title">Network summary</h2><p className="panel-caption">Current active footprint</p></div></div><div className="panel-body">{stats.isLoading?<div className="skeleton"/>:stats.error?<ErrorState error={stats.error} retry={()=>stats.refetch()}/>:<><div className="data-row"><span className="data-key">Patients</span><span className="data-value">{stats.data?.totalPatients??0}</span></div><div className="data-row"><span className="data-key">Active doctors</span><span className="data-value">{stats.data?.activeDoctors??0}</span></div><div className="data-row"><span className="data-key">Active permissions</span><span className="data-value">{stats.data?.activePermissions??0}</span></div><div className="data-row"><span className="data-key">Consultations</span><span className="data-value">{stats.data?.totalConsultations??0}</span></div></>}</div></section></div>}</>}
    {toast&&<div className="toast-message" role="status">{toast}</div>}
  </>;
}

function SearchField({ value, onChange, placeholder, testId }: { value: string; onChange: (value: string) => void; placeholder: string; testId: string }) {
  return <div className="searchbox"><Search size={15} color="#81918c"/><input type="search" value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} data-testid={testId}/></div>;
}
function UserResult({ user, action }: { user: User; action: ReactNode }) {
  return <div className="data-row" data-testid={`user-result-${user.id}`}><div className="person-cell"><div className="avatar">{initials(user.name)}</div><span>{user.name}<small style={{display:'block',fontWeight:400,color:'#92a09a',marginTop:3}}>{user.email}</small></span></div><span className={user.status==='PENDING'?'tag warning':'tag'}>{user.role.replaceAll('_',' ')} · {user.status.toLowerCase()}</span>{action}</div>;
}

export default App;