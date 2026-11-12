# Accessibility

Target: **WCAG 2.2 level AA**, the international standard for web accessibility. Most national rules, and many health-sector buyers, refer to it.

## Where things stand

**Checked and passing (November 2026):**

- Automated rules: every screen of every role (patient, doctor, administrator) plus sign-in, sign-up and the legal pages has no axe-core violations for WCAG 2.0, 2.1 and 2.2 A and AA. Checked in French and English, at desktop width and at 320 px.
- Reflow (1.4.10): no sideways scrolling at 320 px wide, which is what 400% zoom on a laptop looks like.
- Zoom (1.4.4): pinch-zoom is allowed on phones.
- Text contrast (1.4.3): all text is at least 4.5:1 against its background.
- Field borders and focus rings (1.4.11, 2.4.7): text fields have a border of at least 3:1 and a clear dark-teal focus ring. Buttons and links show a 3 px outline when reached with the keyboard.
- Keyboard (2.1.1, 2.4.3): sign-in, moving between screens and filling in forms work with the keyboard alone. A "Skip to content" link is the first stop.
- Dialogs: focus moves into the dialog when it opens, Tab stays inside it, Escape closes it, and focus returns to the button that opened it.
- Page language (3.1.1): the page is marked French or English to match the choice, so screen readers pronounce it correctly.
- Page titles (2.4.2): the browser tab names the current screen, for example "Profil · Mon carnet".
- Headings (1.3.1): each page has one main heading, and levels are not skipped.
- Motion: animations are reduced when the device asks for reduced motion.
- Minimum text size raised to 11 px (it was 9–10 px in places).

**Not yet checked (do before claiming conformance):**

- **Screen readers.** Use the app with NVDA (Windows), VoiceOver (iPhone/Mac) and TalkBack (Android) for the main tasks: sign up, sign in with two-step sign-in, share the CM ID, read records, emergency lookup (doctor), and approving a doctor (admin).
- **People.** Ask a few users with visual, motor or reading difficulties to try those tasks. This finds problems no tool sees.
- **The printed booklet PDF.** It is made by the browser's "Save as PDF", which does not produce a tagged, accessible PDF.
- **Plain language.** Some wording is still technical (for example "CM ID", "arrondissement"). See the usability work.

Automated tools find roughly a third of accessibility problems. Passing them is necessary, not sufficient.

## Keeping it this way

Every change runs the accessibility check on GitHub (`.github/workflows/checks.yml`). To run it locally:

```bash
pnpm --filter @workspace/medichain run build
```

```bash
pnpm --filter @workspace/api-server run test:accessibility
```

The build needs `PORT` and `BASE_PATH` set (any port, `BASE_PATH=/`). The check also needs the local Supabase stack, as for the other tests (`docs/supabase.md`). It signs in as a patient, a doctor and an administrator, opens every screen, and fails on any WCAG A/AA rule violation or on sideways scrolling at 320 px.

When adding screens or colours:

- Text colour must reach 4.5:1 against its background (3:1 for text of 18.5 px bold or 24 px and larger). Use a contrast checker before committing a new grey.
- Add new screens to `SCREENS` in `artifacts/api-server/tests/accessibility/screens.test.mjs`.
- Use the existing `Modal` for dialogs so keyboard handling comes for free.

## Accessibility statement (draft for the website)

> Mon carnet aims to meet the Web Content Accessibility Guidelines (WCAG) 2.2 at level AA. Every screen is checked automatically against these guidelines and at 400% zoom. Testing with screen readers and with users with disabilities is still to be done, so some problems may remain. If you have difficulty using Mon carnet, contact us at [contact address] and we will help you and fix the problem.
