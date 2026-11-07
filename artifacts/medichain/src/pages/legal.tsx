import { LEGAL_DOCUMENTS_VERSION } from '@workspace/api-zod';
import { Link } from 'wouter';
import { t, useLanguage, type Language } from '@/lib/i18n';

/**
 * Privacy policy and terms of use, in French and English.
 *
 * DRAFT: written for review by a lawyer qualified in Cameroonian law before launch.
 * Text in [square brackets] must be completed by the operator. When the substance of either
 * document changes, update LEGAL_DOCUMENTS_VERSION in lib/api-zod/src/legal.ts so that every
 * account is asked to accept the new version.
 */
export type LegalKind = 'privacy' | 'terms';

type Section = { title: string; paragraphs?: string[]; bullets?: string[] };
type LegalDocument = { title: string; intro: string; sections: Section[] };

const OPERATOR = { fr: '[Nom de l’organisation exploitante]', en: '[Name of the operating organisation]' };
const CONTACT = { fr: '[adresse e-mail et adresse postale du délégué à la protection des données]', en: '[email and postal address of the data protection officer]' };

const documents: Record<LegalKind, Record<Language, LegalDocument>> = {
  privacy: {
    fr: {
      title: 'Politique de confidentialité',
      intro: `Mon carnet est un carnet de santé numérique. Il est exploité par ${OPERATOR.fr}, responsable du traitement de vos données personnelles. Cette politique explique quelles données nous traitons, pourquoi, avec qui elles sont partagées et quels sont vos droits au titre de la loi n° 2024/017 du 23 décembre 2024 relative à la protection des données à caractère personnel au Cameroun.`,
      sections: [
        { title: 'Données que nous traitons', bullets: [
          'Identité et compte : nom, e-mail, mot de passe (stocké sous forme chiffrée irréversible), sexe, date de naissance ou âge estimé, numéro de CNI (facultatif), coordonnées, région et arrondissement (facultatifs), langue.',
          'Données de santé (patients) : informations d’urgence (groupe sanguin, allergies, taille, poids, contact d’urgence), fiches médicales, diagnostics codés, ordonnances et résultats de laboratoire saisis par vos médecins.',
          'Données professionnelles (médecins) : numéro d’inscription à l’Ordre, établissement de rattachement.',
          'Journal des accès : qui a consulté ou ajouté des informations à votre dossier, quand, depuis quel établissement et pour quel motif.',
        ] },
        { title: 'Pourquoi nous les traitons', bullets: [
          'Tenir votre carnet de santé et le partager avec les médecins que vous autorisez (base : votre consentement explicite pour les données de santé).',
          'Permettre à un médecin d’accéder à vos informations d’urgence si vous ne pouvez pas communiquer (base : la sauvegarde de vos intérêts vitaux). Chaque consultation est enregistrée et vous est notifiée.',
          'Sécuriser le service, prévenir les abus et répondre à nos obligations légales.',
          'Produire des statistiques agrégées sur l’activité de soins et les signaux épidémiques, sans identifier les patients ; les groupes de moins de 5 patients ne sont pas affichés.',
        ] },
        { title: 'Qui peut voir vos données', bullets: [
          'Vous-même.',
          'Les médecins à qui vous avez donné accès, pendant la durée choisie. Vous pouvez retirer cet accès à tout moment.',
          'En cas d’urgence, un médecin qui vous recherche par votre nom voit uniquement vos informations d’urgence, après avoir indiqué un motif.',
          'Les administrateurs de Mon carnet, pour la gestion des comptes uniquement. Ils n’ont pas accès à vos fiches médicales ni à votre numéro de CNI.',
          'Nos prestataires techniques d’hébergement : [nom du prestataire et pays d’hébergement]. Si les données sont hébergées hors du Cameroun, ce transfert est encadré conformément à la loi.',
          'Les autorités, uniquement lorsque la loi l’exige.',
        ] },
        { title: 'Durée de conservation', paragraphs: [
          'Vos données sont conservées tant que votre compte est actif. Lorsque vous demandez la suppression de votre compte, il est supprimé ou fermé. Si la loi impose de conserver les dossiers médicaux, vos fiches sont conservées pendant [durée légale de conservation des dossiers médicaux], puis supprimées ; votre compte, vos identifiants et vos coordonnées sont supprimés immédiatement.',
        ] },
        { title: 'Vos droits', bullets: [
          'Accès : téléchargez une copie de vos données depuis votre Profil.',
          'Rectification : modifiez votre identité et vos informations dans votre Profil ; une fiche médicale enregistrée ne peut pas être modifiée, mais un médecin peut ajouter un suivi correctif.',
          'Suppression : demandez la suppression de votre compte depuis votre Profil. Une réponse vous est apportée sous 30 jours.',
          'Retrait du consentement : vous pouvez retirer à tout moment l’accès de chaque médecin, ou demander la suppression de votre compte.',
          `Réclamation : contactez-nous à ${CONTACT.fr}, ou saisissez l’autorité de protection des données personnelles prévue par la loi n° 2024/017.`,
        ] },
        { title: 'Sécurité', paragraphs: [
          'Les échanges sont chiffrés (HTTPS), les mots de passe sont stockés sous forme chiffrée irréversible, les tentatives de connexion sont limitées, les sessions inactives sont fermées et chaque accès à un dossier est journalisé. En cas de violation de données susceptible de vous affecter, nous vous en informerons, ainsi que l’autorité compétente, dans les délais prévus par la loi.',
        ] },
        { title: 'Enfants', paragraphs: [
          'Le compte d’un mineur doit être créé et géré par l’un de ses parents ou son représentant légal.',
        ] },
        { title: 'Modifications et contact', paragraphs: [
          'Nous vous demanderons d’accepter toute nouvelle version de cette politique. Pour toute question : ' + CONTACT.fr + '.',
        ] },
      ],
    },
    en: {
      title: 'Privacy policy',
      intro: `Mon carnet is a digital health booklet. It is operated by ${OPERATOR.en}, the controller of your personal data. This policy explains what data we process, why, who it is shared with, and your rights under Cameroon's Law No. 2024/017 of 23 December 2024 on the protection of personal data.`,
      sections: [
        { title: 'Data we process', bullets: [
          'Identity and account: name, email, password (stored as an irreversible hash), sex, date of birth or estimated age, national ID card number (optional), contact details, region and arrondissement (optional), language.',
          'Health data (patients): emergency information (blood group, allergies, height, weight, emergency contact), medical records, coded diagnoses, prescriptions and lab results entered by your doctors.',
          'Professional data (doctors): medical council registration number and hospital or clinic.',
          'Access log: who viewed or added information to your file, when, from which facility and for what reason.',
        ] },
        { title: 'Why we process it', bullets: [
          'To keep your health booklet and share it with the doctors you authorise (basis: your explicit consent for health data).',
          'To let a doctor see your emergency information when you cannot communicate (basis: protecting your vital interests). Every such lookup is logged and you are notified.',
          'To secure the service, prevent misuse and meet our legal obligations.',
          'To produce aggregate statistics on care activity and epidemic signals that do not identify patients; groups of fewer than 5 patients are never shown.',
        ] },
        { title: 'Who can see your data', bullets: [
          'You.',
          'Doctors you have given access to, for the period you choose. You can revoke access at any time.',
          'In an emergency, a doctor who looks you up by name sees only your emergency information, after giving a reason.',
          'Mon carnet administrators, for account management only. They cannot see your medical records or your national ID number.',
          'Our hosting providers: [provider name and hosting country]. If data is hosted outside Cameroon, the transfer is governed as the law requires.',
          'Authorities, only where the law requires it.',
        ] },
        { title: 'How long we keep it', paragraphs: [
          'Your data is kept while your account is active. When you ask for your account to be deleted, it is erased or closed. Where the law requires medical records to be kept, your records are kept for [legal retention period for medical records] and then deleted; your account, sign-in and contact details are removed straight away.',
        ] },
        { title: 'Your rights', bullets: [
          'Access: download a copy of your data from your Profile.',
          'Correction: update your identity and details in your Profile; a saved medical record cannot be edited, but a doctor can add a correcting follow-up.',
          'Deletion: ask for your account to be deleted from your Profile. You will receive an answer within 30 days.',
          'Withdrawing consent: revoke any doctor’s access at any time, or ask for your account to be deleted.',
          `Complaints: contact us at ${CONTACT.en}, or the personal data protection authority established by Law No. 2024/017.`,
        ] },
        { title: 'Security', paragraphs: [
          'Connections are encrypted (HTTPS), passwords are stored as irreversible hashes, sign-in attempts are limited, idle sessions are closed and every access to a file is logged. If a data breach is likely to affect you, we will inform you and the competent authority within the time the law requires.',
        ] },
        { title: 'Children', paragraphs: [
          'A minor’s account must be created and managed by a parent or legal guardian.',
        ] },
        { title: 'Changes and contact', paragraphs: [
          'We will ask you to accept any new version of this policy. Questions: ' + CONTACT.en + '.',
        ] },
      ],
    },
  },
  terms: {
    fr: {
      title: 'Conditions d’utilisation',
      intro: `Ces conditions régissent l’utilisation de Mon carnet, exploité par ${OPERATOR.fr}. En créant un compte, vous les acceptez.`,
      sections: [
        { title: 'Le service', paragraphs: [
          'Mon carnet permet aux patients de tenir un carnet de santé numérique et de le partager avec les médecins de leur choix, et aux médecins de consulter et compléter ces carnets avec l’accord des patients.',
        ] },
        { title: 'Ce n’est pas un service d’urgence ni un avis médical', paragraphs: [
          'En cas d’urgence, contactez immédiatement les services d’urgence ou rendez-vous dans la formation sanitaire la plus proche. Les informations affichées sont celles saisies par les patients et les soignants ; elles ne remplacent pas un examen ni l’avis d’un professionnel de santé. Les signaux épidémiques sont des indicateurs à vérifier, pas des diagnostics.',
        ] },
        { title: 'Votre compte', bullets: [
          'Fournissez des informations exactes et tenez-les à jour.',
          'Gardez votre mot de passe confidentiel. Ne communiquez votre identifiant CM qu’aux médecins à qui vous souhaitez donner accès.',
          'Le compte d’un mineur est géré par un parent ou un représentant légal.',
        ] },
        { title: 'Obligations des médecins', bullets: [
          'Être inscrit à l’Ordre national des médecins du Cameroun et fournir un numéro d’inscription exact ; il est vérifié manuellement.',
          'N’accéder à un dossier que pour soigner le patient, dans le respect du secret médical et du code de déontologie.',
          'N’utiliser la recherche d’urgence qu’en cas d’urgence réelle et indiquer un motif exact : chaque recherche est journalisée et notifiée au patient.',
          'Les fiches enregistrées sont définitives ; toute correction se fait par un suivi lié.',
        ] },
        { title: 'Utilisations interdites', bullets: [
          'Accéder ou tenter d’accéder aux données d’une personne sans y être autorisé.',
          'Usurper l’identité d’un patient ou d’un professionnel de santé.',
          'Perturber le service ou en contourner les mesures de sécurité.',
        ] },
        { title: 'Suspension et fermeture', paragraphs: [
          'Nous pouvons suspendre un compte en cas de manquement à ces conditions ou de risque pour la sécurité des patients. Vous pouvez demander la suppression de votre compte à tout moment depuis votre Profil.',
        ] },
        { title: 'Disponibilité et responsabilité', paragraphs: [
          '[Clause de disponibilité du service et de limitation de responsabilité, à rédiger par le conseil juridique.]',
        ] },
        { title: 'Droit applicable', paragraphs: [
          'Ces conditions sont régies par le droit camerounais. [Juridiction compétente à préciser.]',
        ] },
        { title: 'Modifications et contact', paragraphs: [
          'Nous vous demanderons d’accepter toute nouvelle version de ces conditions. Pour toute question : ' + CONTACT.fr + '.',
        ] },
      ],
    },
    en: {
      title: 'Terms of use',
      intro: `These terms govern the use of Mon carnet, operated by ${OPERATOR.en}. By creating an account you accept them.`,
      sections: [
        { title: 'The service', paragraphs: [
          'Mon carnet lets patients keep a digital health booklet and share it with doctors of their choice, and lets doctors view and add to those booklets with the patient’s agreement.',
        ] },
        { title: 'Not an emergency service or medical advice', paragraphs: [
          'In an emergency, contact emergency services or go to the nearest health facility straight away. The information shown is what patients and clinicians entered; it does not replace an examination or a health professional’s advice. Epidemic signals are indicators to be checked, not diagnoses.',
        ] },
        { title: 'Your account', bullets: [
          'Give accurate information and keep it up to date.',
          'Keep your password private. Share your CM ID only with doctors you want to give access to.',
          'A minor’s account is managed by a parent or legal guardian.',
        ] },
        { title: 'Doctors’ obligations', bullets: [
          'Be registered with the Ordre National des Médecins du Cameroun and give an accurate registration number; it is checked manually.',
          'Open a file only to care for that patient, in line with medical confidentiality and the code of ethics.',
          'Use emergency lookup only in a real emergency and give an accurate reason: every lookup is logged and the patient is told.',
          'Saved records are permanent; corrections are added as linked follow-ups.',
        ] },
        { title: 'Prohibited use', bullets: [
          'Accessing or trying to access anyone’s data without authorisation.',
          'Impersonating a patient or a health professional.',
          'Disrupting the service or getting around its security measures.',
        ] },
        { title: 'Suspension and closure', paragraphs: [
          'We may suspend an account that breaks these terms or puts patients at risk. You can ask for your account to be deleted at any time from your Profile.',
        ] },
        { title: 'Availability and liability', paragraphs: [
          '[Service availability and limitation of liability clause, to be drafted by legal counsel.]',
        ] },
        { title: 'Governing law', paragraphs: [
          'These terms are governed by Cameroonian law. [Competent court to be specified.]',
        ] },
        { title: 'Changes and contact', paragraphs: [
          'We will ask you to accept any new version of these terms. Questions: ' + CONTACT.en + '.',
        ] },
      ],
    },
  },
};

export function LegalPage({ kind }: { kind: LegalKind }) {
  const language = useLanguage();
  const doc = documents[kind][language];
  const other: LegalKind = kind === 'privacy' ? 'terms' : 'privacy';
  return <div className="legal-page">
    <main className="legal-body" lang={language}>
      <p className="legal-back"><Link href="/">{t('Back to Mon carnet')}</Link> · <Link href={`/${other}`}>{documents[other][language].title}</Link></p>
      <div className="legal-draft" role="note">{t('Draft pending legal review. This text is not yet final and must be checked by a lawyer before Mon carnet is launched.')}</div>
      <h1>{doc.title}</h1>
      <p className="legal-version">{t('Version {0}', { 0: LEGAL_DOCUMENTS_VERSION })}</p>
      <p>{doc.intro}</p>
      {doc.sections.map((section) => <section key={section.title}>
        <h2>{section.title}</h2>
        {section.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        {section.bullets && <ul>{section.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul>}
      </section>)}
    </main>
  </div>;
}
