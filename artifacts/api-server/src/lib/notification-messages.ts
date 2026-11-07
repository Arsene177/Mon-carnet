/** Notification texts in the recipient's language ("fr" or "en"). */
export type NotificationLanguage = "fr" | "en";

type Message = { title: string; body: string };

const at = (hospital: string | null) => (hospital ? ` (${hospital})` : "");

export function languageOf(value: string | null | undefined): NotificationLanguage {
  return value === "en" ? "en" : "fr";
}

export const notificationMessages = {
  accessRequested(language: NotificationLanguage, doctorName: string, hospital: string | null): Message {
    return language === "fr"
      ? {
          title: "Un médecin demande à ouvrir votre carnet",
          body: `${doctorName}${at(hospital)} a saisi votre identifiant CM et demande à consulter votre dossier médical. Acceptez ou refusez la demande dans Contrôle d’accès. Elle expire après 7 jours.`,
        }
      : {
          title: "A doctor asked to open your booklet",
          body: `${doctorName}${at(hospital)} entered your CM ID and asked to see your medical records. Approve or reject the request in Access control. It expires after 7 days.`,
        };
  },
  accessApproved(language: NotificationLanguage, patientName: string, expiresOn: string | null): Message {
    return language === "fr"
      ? {
          title: "Accès au carnet accepté",
          body: `${patientName} a accepté votre demande. Saisissez de nouveau son identifiant CM dans Saisie de fiche pour ouvrir le carnet.${expiresOn ? ` L’accès prend fin le ${expiresOn}.` : ""}`,
        }
      : {
          title: "Booklet access approved",
          body: `${patientName} approved your request. Enter their CM ID again in Record entry to open the booklet.${expiresOn ? ` Access ends on ${expiresOn}.` : ""}`,
        };
  },
  accessRejected(language: NotificationLanguage, patientName: string): Message {
    return language === "fr"
      ? { title: "Accès au carnet refusé", body: `${patientName} a refusé votre demande d’ouverture de son carnet.` }
      : { title: "Booklet access declined", body: `${patientName} declined your request to open their booklet.` };
  },
  deletionRequested(language: NotificationLanguage, accountName: string): Message {
    return language === "fr"
      ? { title: "Nouvelle demande de suppression de compte", body: `${accountName} a demandé la suppression de son compte. Traitez la demande dans Demandes de compte.` }
      : { title: "New account deletion request", body: `${accountName} asked for their account to be deleted. Handle the request in Account requests.` };
  },
  deletionRejected(language: NotificationLanguage, note: string): Message {
    return language === "fr"
      ? { title: "Demande de suppression refusée", body: `Votre demande de suppression de compte a été refusée. Motif : « ${note} ».` }
      : { title: "Deletion request declined", body: `Your account deletion request was declined. Reason: "${note}".` };
  },
  emergencyLookup(language: NotificationLanguage, doctorName: string, hospital: string | null, reason: string): Message {
    return language === "fr"
      ? {
          title: "Vos informations d’urgence ont été consultées",
          body: `${doctorName}${at(hospital)} vous a recherché(e) par votre nom et a consulté vos informations d’urgence. Motif indiqué : « ${reason} ». Si vous ne reconnaissez pas cette consultation, signalez-la au support Mon carnet.`,
        }
      : {
          title: "Your emergency information was viewed",
          body: `${doctorName}${hospital ? ` at ${hospital}` : ""} looked you up by name and viewed your emergency information. Reason given: "${reason}". If you do not recognise this, report it to Mon carnet support.`,
        };
  },
};
