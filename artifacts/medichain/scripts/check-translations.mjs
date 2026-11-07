// Lists English text wrapped in t("...") that has no French entry in src/lib/i18n-fr.ts.
// Run: pnpm --filter @workspace/medichain run i18n:check
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = new URL('../src/', import.meta.url).pathname;
// Text that is written the same way in French.
const SAME_IN_FRENCH = new Set(['Mon', 'carnet', 'Mon carnet', 'MON CARNET', 'kg', 'cm /', 'cm ·', 'CM123ABC', 'Contact', 'Patient', 'Patients', 'Message', 'Allergies', 'Guide', 'Administration', 'Probable', 'probable', 'Consultation', 'Consultations', 'Dose', 'Mon carnet - {0} {1}', 'Littoral', 'Centre', 'COVID-19']);

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'ui' ? [] : files(path);
    return /\.(tsx?|ts)$/.test(name) ? [path] : [];
  });
}

const frSource = readFileSync(join(root, 'lib/i18n-fr.ts'), 'utf8');
const frKeys = new Set([...frSource.matchAll(/^ {2}("(?:[^"\\]|\\.)*"): /gm)].map((m) => JSON.parse(m[1])));
const missing = new Map();
for (const file of files(root)) {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't') {
      const [arg] = node.arguments;
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) && !frKeys.has(arg.text) && !SAME_IN_FRENCH.has(arg.text)) {
        const { line } = sf.getLineAndCharacterOfPosition(arg.getStart());
        missing.set(arg.text, `${file.slice(root.length)}:${line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
if (missing.size) {
  console.error(`${missing.size} text(s) without a French translation:`);
  for (const [text, where] of missing) console.error(`  ${where}  ${JSON.stringify(text)}`);
  process.exit(1);
}
console.log('Every wrapped text has a French translation.');
