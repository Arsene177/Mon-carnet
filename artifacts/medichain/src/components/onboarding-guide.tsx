import { useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  RotateCcw,
  X,
} from 'lucide-react';
import type { User } from '@workspace/api-client-react';
import type { WorkspaceTab } from '@/lib/navigation';

type GuideStep = {
  tab: WorkspaceTab;
  title: string;
  description: string;
  target: 'workspace-navigation' | 'section-heading';
};

function stepsForRole(role: User['role']): GuideStep[] {
  if (role === 'PATIENT') {
    return [
      {
        tab: 'Overview',
        title: 'Your health overview',
        description: 'Start here for your record count, care essentials, and recent activity. Use the workspace sections to move around.',
        target: 'workspace-navigation',
      },
      {
        tab: 'Records',
        title: 'Medical records',
        description: 'Records added by your doctors appear in this timeline. Open an entry to review its details and download a copy.',
        target: 'section-heading',
      },
      {
        tab: 'Access control',
        title: 'Access control',
        description: 'Review doctor requests, choose how long to share your records, and revoke access whenever you need.',
        target: 'section-heading',
      },
      {
        tab: 'Emergency info',
        title: 'Emergency information',
        description: 'Keep your blood group, allergies, measurements, and emergency contact current for your care team.',
        target: 'section-heading',
      },
    ];
  }

  if (role === 'PENDING_DOCTOR') {
    return [
      {
        tab: 'Patients',
        title: 'Doctor account review',
        description: 'Your account is under review. Once approved, patient search and record entry will become available.',
        target: 'section-heading',
      },
    ];
  }

  if (role === 'DOCTOR') {
    return [
      {
        tab: 'Patients',
        title: 'Find a patient',
        description: 'Search for a patient by name or email. Emergency details may be visible, but full records require the patient’s active permission.',
        target: 'workspace-navigation',
      },
      {
        tab: 'Record entry',
        title: 'Add a medical record',
        description: 'Choose a patient who granted access, then create a record. Existing records stay read-only; corrections are added as linked follow-ups.',
        target: 'section-heading',
      },
      {
        tab: 'Profile',
        title: 'Your clinician profile',
        description: 'Review the account identity patients see and check your clinical activity.',
        target: 'section-heading',
      },
    ];
  }

  return [
    {
      tab: 'System overview',
      title: 'System overview',
      description: 'Review account totals, recent activity, and the operational status of the care network.',
      target: 'workspace-navigation',
    },
    {
      tab: 'Doctor approvals',
      title: 'Doctor approvals',
      description: 'Review pending clinician accounts and revoke an active doctor account when necessary.',
      target: 'section-heading',
    },
    {
      tab: 'User search',
      title: 'User search',
      description: 'Find an account by name or email. This view does not expose patient medical records.',
      target: 'section-heading',
    },
    {
      tab: 'Analytics',
      title: 'Network analytics',
      description: 'Review monthly record activity and aggregate system health information.',
      target: 'section-heading',
    },
  ];
}

type OnboardingGuideProps = {
  user: User;
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
};

export function OnboardingGuide({ user, activeTab, onTabChange }: OnboardingGuideProps) {
  const steps = useMemo(() => stepsForRole(user.role), [user.role]);
  const [dialogMode, setDialogMode] = useState<'menu' | 'text' | null>(null);
  const [tourIndex, setTourIndex] = useState<number | null>(null);
  const completionKey = `medichain:onboarding:v1:${user.id}`;

  useEffect(() => {
    let completed = false;
    try {
      completed = window.localStorage.getItem(completionKey) === 'complete';
    } catch {
      completed = false;
    }
    if (!completed) setTourIndex(0);
  }, [completionKey]);

  const activeStep = tourIndex === null ? undefined : steps[tourIndex];
  useEffect(() => {
    if (activeStep && activeStep.tab !== activeTab) onTabChange(activeStep.tab);
  }, [activeStep, activeTab, onTabChange]);

  const finishTour = () => {
    try {
      window.localStorage.setItem(completionKey, 'complete');
    } catch {
      // The tour still works when browser storage is unavailable.
    }
    setTourIndex(null);
  };

  const startTour = () => {
    setDialogMode(null);
    setTourIndex(0);
  };

  const openGuideSection = (tab: WorkspaceTab) => {
    onTabChange(tab);
    setDialogMode(null);
  };

  return (
    <>
      <button
        type="button"
        className="btn secondary guide-trigger"
        onClick={() => setDialogMode('menu')}
        aria-haspopup="dialog"
        data-testid="button-guide"
      >
        <CircleHelp size={15} />
        Guide
      </button>

      {dialogMode && (
        <GuideDialog
          mode={dialogMode}
          steps={steps}
          onClose={() => setDialogMode(null)}
          onReadGuide={() => setDialogMode('text')}
          onReplay={startTour}
          onOpenSection={openGuideSection}
        />
      )}

      {activeStep && tourIndex !== null && (
        <TourSpotlight
          step={activeStep}
          stepNumber={tourIndex + 1}
          totalSteps={steps.length}
          activeTab={activeTab}
          onBack={() => setTourIndex((index) => index === null ? null : Math.max(index - 1, 0))}
          onNext={() => {
            if (tourIndex + 1 >= steps.length) finishTour();
            else setTourIndex(tourIndex + 1);
          }}
          onClose={finishTour}
        />
      )}
    </>
  );
}

function GuideDialog({
  mode,
  steps,
  onClose,
  onReadGuide,
  onReplay,
  onOpenSection,
}: {
  mode: 'menu' | 'text';
  steps: GuideStep[];
  onClose: () => void;
  onReadGuide: () => void;
  onReplay: () => void;
  onOpenSection: (tab: WorkspaceTab) => void;
}) {
  return (
    <div
      className="guide-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={`panel guide-dialog ${mode === 'text' ? 'guide-dialog-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="guide-dialog-title"
      >
        <header className="guide-dialog-header">
          <div>
            <p className="eyebrow">Medichain help</p>
            <h2 id="guide-dialog-title">{mode === 'menu' ? 'Choose a guide' : 'Written guide'}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close guide">
            <X size={16} />
          </button>
        </header>
        {mode === 'menu' ? (
          <div className="guide-dialog-body">
            <p className="subhead guide-intro">Choose how you’d like to review your workspace.</p>
            <button type="button" className="guide-choice" onClick={onReplay} data-testid="button-guide-replay">
              <span className="guide-choice-icon"><RotateCcw size={17} /></span>
              <span><strong>Replay the section tour</strong><small>Step through the workspace with highlighted sections.</small></span>
              <ChevronRight size={16} />
            </button>
            <button type="button" className="guide-choice" onClick={onReadGuide} data-testid="button-guide-written">
              <span className="guide-choice-icon"><BookOpen size={17} /></span>
              <span><strong>Read the written guide</strong><small>See what each workspace section is for.</small></span>
              <ChevronRight size={16} />
            </button>
          </div>
        ) : (
          <div className="guide-dialog-body">
            <ol className="written-guide-list">
              {steps.map((step, index) => (
                <li key={step.tab} className="written-guide-item">
                  <span className="written-guide-number">{index + 1}</span>
                  <div className="written-guide-copy">
                    <h3>{step.title}</h3>
                    <p>{step.description}</p>
                    <button type="button" className="btn ghost small" onClick={() => onOpenSection(step.tab)}>
                      Open section <ChevronRight size={13} />
                    </button>
                  </div>
                </li>
              ))}
            </ol>
            <div className="form-actions">
              <button type="button" className="btn ghost" onClick={onClose}>Close</button>
              <button type="button" className="btn secondary" onClick={onReplay}>
                <RotateCcw size={14} /> Replay tour
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function TourSpotlight({
  step,
  stepNumber,
  totalSteps,
  activeTab,
  onBack,
  onNext,
  onClose,
}: {
  step: GuideStep;
  stepNumber: number;
  totalSteps: number;
  activeTab: WorkspaceTab;
  onBack: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const [targetRect, setTargetRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);

  useEffect(() => {
    const targetSelector = `[data-tour="${step.target}"]`;
    const measure = () => {
      const target = document.querySelector<HTMLElement>(targetSelector);
      if (!target) {
        setTargetRect(null);
        return;
      }
      const rect = target.getBoundingClientRect();
      setTargetRect({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
    };
    const initialMeasure = window.setTimeout(() => {
      document.querySelector<HTMLElement>(targetSelector)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
      window.requestAnimationFrame(measure);
    }, 50);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.clearTimeout(initialMeasure);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [step.target, activeTab]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight') onNext();
      if (event.key === 'ArrowLeft' && stepNumber > 1) onBack();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onBack, onClose, onNext, stepNumber]);

  const cardWidth = Math.min(360, window.innerWidth - 32);
  const cardPosition = targetRect
    ? {
        top: window.innerHeight - targetRect.top - targetRect.height > 250
          ? targetRect.top + targetRect.height + 14
          : Math.max(16, targetRect.top - 230),
        left: Math.max(16, Math.min(targetRect.left, window.innerWidth - cardWidth - 16)),
        width: cardWidth,
      }
    : undefined;

  return (
    <div className="tour-layer">
      <div className="tour-scrim" aria-hidden="true" />
      {targetRect && (
        <div
          className="tour-spotlight"
          aria-hidden="true"
          style={{
            top: targetRect.top - 5,
            left: targetRect.left - 5,
            width: targetRect.width + 10,
            height: targetRect.height + 10,
          }}
        />
      )}
      <section
        className={`tour-card ${cardPosition ? '' : 'tour-card-centered'}`}
        style={cardPosition}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-step-title"
        aria-describedby="tour-step-description"
        aria-live="polite"
        data-testid="onboarding-tour"
      >
        <div className="tour-progress"><span>Workspace tour</span><span>Step {stepNumber} of {totalSteps}</span></div>
        <h2 id="tour-step-title">{step.title}</h2>
        <p id="tour-step-description">{step.description}</p>
        <div className="tour-actions">
          <button type="button" className="btn ghost small" onClick={onClose} data-testid="button-tour-skip">End tour</button>
          <div>
            <button type="button" className="btn ghost small" onClick={onBack} disabled={stepNumber === 1} aria-label="Previous tour step">
              <ChevronLeft size={14} /> Back
            </button>
            <button type="button" className="btn small" onClick={onNext} data-testid="button-tour-next">
              {stepNumber === totalSteps ? 'Finish' : 'Next'} <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}