# Spec: Structured Image Layout Contract

## Objective

Replace prose-to-regex layout guessing with a validated template contract shared by visual planning, full-page generation, mock rendering, and visual QA. A generated page must follow the same reading geometry used by validation and legacy mock fixtures. Failed deliveries remain visible as read-only previews.

For live OpenClaw output, the image model now owns the complete page—background, typography, cards, labels, and decoration—in one generation. The structured template remains a prompt and QA contract, not a second compositor. Sharp overlays remain limited to mock fixtures and explicit legacy tooling.

## Tech Stack

- Node.js 24 ESM
- `node:test`
- Sharp SVG/PNG compositing
- Existing OpenClaw text, image, and vision calls
- No new dependency or database migration

## Commands

- Focused tests: `node --test tests/visual-plan.test.mjs tests/images.test.mjs tests/pipeline.test.mjs`
- Full tests: `npm test`
- Type check: `npm run typecheck`
- Production build: `npm run build`
- Live verification: `node src/cli.mjs worker --once --worker-id structured-layout-task-15`

## Project Structure

- `src/visual-plan.mjs`: validates the model-selected layout template.
- `src/images.mjs`: maps templates to deterministic title, content, label, and subtitle slots.
- `src/pipeline.mjs`: sends the same template and full-page composition instruction to image generation.
- `src/image-alignment.mjs`: evaluates the structured template rather than inferred prose geometry.
- `tests/`: contract, renderer, pipeline, and failure-preview regressions.

## Interface

Every live visual page must include:

```js
{
  layoutSchemaVersion: 1,
  layoutTemplate: 'DETAIL_RIGHT_STACK',
  layoutDirection: 'Human-readable explanation only; never used for slot selection.'
}
```

Allowed templates are owned by the program and restricted by page kind:

- hero: `HERO_LEFT`, `HERO_RIGHT`
- steps: `STEPS_LEFT`, `STEPS_RIGHT`, `STEPS_DIAGONAL`
- detail: `DETAIL_LEFT_STACK`, `DETAIL_RIGHT_STACK`, `DETAIL_SPLIT`
- comparison: `COMPARISON_RIGHT_STACK`, `COMPARISON_TWO_COLUMN`, `COMPARISON_FOUR_COLUMN`
- checklist: `CHECKLIST_RIGHT`, `CHECKLIST_LOWER_GRID`
- summary: `SUMMARY_GRID`

In live mode the image model receives the exact visible-text whitelist and renders the complete page in one pass. In mock mode the renderer derives pixel geometry locally. Live OCR must still match the whitelist; a failed page may receive bounded full-page image edits using the previous page image as input, but no deterministic text layer is composited afterward.

## Code Style

Use explicit template maps instead of regex branches:

```js
const TEMPLATE_GEOMETRY = {
  DETAIL_RIGHT_STACK: {
    titlePosition: 'top-right',
    contentLayout: 'right-detail',
    subjectRegion: 'left 52%',
    textSafeRegion: 'right 48%',
  },
};
```

## Testing Strategy

- Contract tests reject missing, unknown, or kind-incompatible templates.
- Renderer tests retain exact slot positions for mock/legacy output.
- Pipeline tests assert the selected template and exact visible text reach one-pass image generation.
- Live pipeline tests assert Sharp text overlays are skipped and OCR failures use image-model edits only.
- Existing OCR, quality, checkpoint, and failure-preview tests remain green.
- One live task is run only after all local gates pass; task 16 must remain untouched.

## Boundaries

- Always: preserve failed previews, validate exact visible text with OCR, and retry only the active page/task.
- Ask first: new dependencies, schema migrations, publishing, or relaxing the quality score gate.
- Never: infer live slot geometry from prose, composite a second text layer onto live images, approve or export failed previews, run multiple live tasks concurrently.

## Success Criteria

- Live visual plans cannot omit `layoutTemplate`.
- Live image prompts contain template-specific composition plus the exact visible-text whitelist.
- Live images are not passed through `applyDeterministicTextOverlay`.
- OCR failures are repaired only through bounded image-model edits.
- Task 15 produces one new saved attempt with no concurrent task.
- Whether pass or fail, the attempt is visible in the review UI.

## Open Questions

None for this increment. Arbitrary user-defined coordinates and freeform templates remain out of scope.
