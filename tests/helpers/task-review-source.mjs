import { readFile } from 'node:fs/promises';

// Business contracts span the controller and responsibility-specific views.
// Keep the existing assertions intact while reading the actual implementation.
export async function readTaskReviewSource() {
  const files = [
    'task-review-types.ts', 'task-review-model.tsx', 'use-task-review-controller.ts',
    'copy-review-panel.tsx', 'image-review-panel.tsx', 'image-plan-review-panel.tsx',
    'task-review-history.tsx', 'task-review-dialog.tsx',
  ];
  return (await Promise.all(files.map(file => readFile(new URL(`../../app/workbench/${file}`, import.meta.url), 'utf8')))).join('\n');
}
