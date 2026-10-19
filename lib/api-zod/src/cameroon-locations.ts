import locationRows from "./cameroon-arrondissements.json";

export type CameroonArrondissement = {
  region: string;
  arrondissement: string;
  code: string;
};

export const CAMEROON_ARRONDISSEMENTS: readonly CameroonArrondissement[] = locationRows;

export const CAMEROON_REGIONS = [...new Set(CAMEROON_ARRONDISSEMENTS.map((location) => location.region))].sort();

export function isValidCameroonLocation(region: unknown, arrondissement: unknown): boolean {
  if (region === null && arrondissement === null) return true;
  if (typeof region !== "string" || !CAMEROON_REGIONS.includes(region)) return false;
  if (arrondissement === null) return true;
  return typeof arrondissement === "string" && CAMEROON_ARRONDISSEMENTS.some(
    (location) => location.region === region && location.arrondissement === arrondissement,
  );
}
