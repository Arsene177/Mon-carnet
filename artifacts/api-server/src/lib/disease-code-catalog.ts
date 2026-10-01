import { db, diseaseCodesTable, type InsertDiseaseCode } from "@workspace/db";

const diseaseCodeSeed: InsertDiseaseCode[] = [
  {
    code: "A00",
    codingSystem: "ICD-10",
    release: "WHO 2019",
    diseaseName: "Cholera",
    description: "Cholera",
    infectious: true,
    epidemicRelevant: true,
    pandemicRelevant: false,
    status: "ACTIVE",
    source: "https://icd.who.int/browse10/2019/en",
  },
  {
    code: "A90",
    codingSystem: "ICD-10",
    release: "WHO 2019",
    diseaseName: "Dengue fever",
    description: "Dengue fever (classical dengue)",
    infectious: true,
    epidemicRelevant: true,
    pandemicRelevant: false,
    status: "ACTIVE",
    source: "https://icd.who.int/browse10/2019/en",
  },
  {
    code: "A98.4",
    codingSystem: "ICD-10",
    release: "WHO 2019",
    diseaseName: "Ebola virus disease",
    description: "Ebola virus disease",
    infectious: true,
    epidemicRelevant: true,
    pandemicRelevant: false,
    status: "ACTIVE",
    source: "https://icd.who.int/browse10/2019/en",
  },
  {
    code: "B04",
    codingSystem: "ICD-10",
    release: "WHO 2019",
    diseaseName: "Mpox (monkeypox)",
    description: "Monkeypox",
    infectious: true,
    epidemicRelevant: true,
    pandemicRelevant: false,
    status: "ACTIVE",
    source: "https://icd.who.int/browse10/2019/en",
  },
  {
    code: "B05",
    codingSystem: "ICD-10",
    release: "WHO 2019",
    diseaseName: "Measles",
    description: "Measles",
    infectious: true,
    epidemicRelevant: true,
    pandemicRelevant: false,
    status: "ACTIVE",
    source: "https://icd.who.int/browse10/2019/en",
  },
  {
    code: "U07.1",
    codingSystem: "ICD-10",
    release: "WHO COVID-19 update (2021)",
    diseaseName: "COVID-19",
    description: "COVID-19, virus identified",
    infectious: true,
    epidemicRelevant: true,
    pandemicRelevant: true,
    status: "ACTIVE",
    source:
      "https://www.who.int/standards/classifications/classification-of-diseases/emergency-use-icd-codes-for-covid-19-disease-outbreak",
  },
];

export async function ensureDiseaseCodeCatalog(): Promise<void> {
  await db
    .insert(diseaseCodesTable)
    .values(diseaseCodeSeed)
    .onConflictDoNothing({
      target: [
        diseaseCodesTable.codingSystem,
        diseaseCodesTable.release,
        diseaseCodesTable.code,
      ],
    });
}