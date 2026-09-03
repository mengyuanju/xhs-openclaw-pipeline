#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { createControlPlaneClient } from '../src/control-plane/client.mjs';
import { adminKnowledgeRoot, withAdminStore } from '../src/admin/runtime.mjs';

function published(version) {
  return version?.status === 'PUBLISHED';
}

function versionContent(item, version) {
  const content = { ...item, ...version };
  delete content.versions;
  delete content.latestVersion;
  delete content.publishedVersion;
  delete content.asset;
  return content;
}

async function migratePrompt(client, template) {
  const versions = [...(template.versions ?? [])]
    .sort((left, right) => Number(left.version) - Number(right.version));
  for (const version of versions) {
    const created = await client.createPromptVersion({
      kind: template.kind,
      name: template.name,
      content: version.content,
    });
    if (published(version)) await client.publishPromptVersion(created.id);
  }
}

function localKnowledgeAssetPath(root, relativePath) {
  const path = resolve(root, relativePath);
  const relation = relative(resolve(root), path);
  if (!relation || relation.startsWith('..') || relation.includes(':')) {
    throw new Error('local knowledge asset escaped the knowledge root');
  }
  return path;
}

async function migrateKnowledgeItems(client, kind, items, knowledgeRoot) {
  for (const item of items) {
    const versions = [...(item.versions ?? [])]
      .sort((left, right) => Number(left.version) - Number(right.version));
    let remoteItemId = null;
    for (const version of versions) {
      const created = await client.createKnowledgeVersion({
        itemId: remoteItemId,
        kind,
        name: item.name,
        content: versionContent(item, version),
      });
      remoteItemId = created.itemId;
      if (kind === 'VISUAL' && item.asset?.relativePath) {
        const content = await readFile(localKnowledgeAssetPath(
          knowledgeRoot,
          item.asset.relativePath,
        ));
        await client.uploadKnowledgeAsset(created.versionId, content);
      }
      if (published(version)) await client.publishKnowledgeVersion(created.versionId);
    }
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const baseUrl = process.env.CONTROL_PLANE_URL?.trim();
  if (!baseUrl) throw new Error('CONTROL_PLANE_URL is required');
  const local = withAdminStore((store) => ({
    prompts: store.listPromptTemplates(),
    settings: store.getProductionSettings().settings,
    copyKnowledge: store.listCopyKnowledge({ page: 1, pageSize: 100 }).data,
    visualKnowledge: store.listVisualKnowledge({ page: 1, pageSize: 100 }).data,
  }));
  const summary = {
    prompts: local.prompts.length,
    copyKnowledge: local.copyKnowledge.length,
    visualKnowledge: local.visualKnowledge.length,
    productionSettings: 1,
  };
  if (!apply) {
    console.log(JSON.stringify({ mode: 'DRY_RUN', ...summary }, null, 2));
    console.log('Re-run with --apply to append these versions to the control plane.');
    return;
  }
  const client = createControlPlaneClient({ baseUrl });
  await client.health();
  await client.updateSetting('production', local.settings);
  for (const prompt of local.prompts) await migratePrompt(client, prompt);
  await migrateKnowledgeItems(client, 'COPY', local.copyKnowledge, adminKnowledgeRoot());
  await migrateKnowledgeItems(client, 'VISUAL', local.visualKnowledge, adminKnowledgeRoot());
  console.log(JSON.stringify({ mode: 'APPLIED', ...summary }, null, 2));
  console.log('Migration appends versions. Do not run --apply again unless duplicates are intended.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
