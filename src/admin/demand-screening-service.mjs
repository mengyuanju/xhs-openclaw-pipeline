import { businessPrompt } from '../prompt-runtime.mjs';
import { z } from 'zod';

import { effectiveModelApiConfig } from '../model-api-config.mjs';
import { createAgentClient as createOpenClawClient } from '../agent-client.mjs';

const MAX_ROWS_PER_BATCH = 50;
const MAX_DATA_CHARACTERS = 20_000;
const MAX_MODEL_NAME_CHARACTERS = 200;

const decisionSchema = z.object({
  rowNumber: z.number().int().positive(),
  demandLevel: z.enum(['STRONG', 'MEDIUM', 'WEAK', 'NONE']),
  reason: z.string().trim().min(1).max(200),
}).strict();

const outputSchema = z.object({
  decisions: z.array(decisionSchema).max(MAX_ROWS_PER_BATCH),
}).strict();

function firstJsonObject(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new TypeError('OpenClaw screening output is invalid');
  }
  const candidates = [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(raw.trim());

  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) candidates.push(raw.slice(start, index + 1));
    }
  }

  for (const candidate of [...new Set(candidates)]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next bounded JSON candidate.
    }
  }
  throw new TypeError('OpenClaw screening output is invalid');
}

export function parseDemandScreeningOutput(raw, { expectedRowNumbers }) {
  if (!Array.isArray(expectedRowNumbers) || expectedRowNumbers.length < 1
    || expectedRowNumbers.length > MAX_ROWS_PER_BATCH) {
    throw new RangeError('expected screening rows are invalid');
  }
  let decisions;
  try {
    decisions = outputSchema.parse(firstJsonObject(raw)).decisions;
  } catch (error) {
    if (error instanceof RangeError) throw error;
    throw new TypeError('OpenClaw screening output is invalid');
  }

  const decisionRowNumbers = decisions.map(({ rowNumber }) => rowNumber);
  if (new Set(decisionRowNumbers).size !== decisionRowNumbers.length) {
    throw new TypeError('OpenClaw screening row numbers must be unique');
  }
  const expected = new Set(expectedRowNumbers);
  const unexpected = decisionRowNumbers.find((rowNumber) => !expected.has(rowNumber));
  if (unexpected !== undefined) {
    throw new TypeError(`OpenClaw screening returned unexpected row ${unexpected}`);
  }
  if (decisions.length !== expected.size
    || expectedRowNumbers.some((rowNumber) => !decisionRowNumbers.includes(rowNumber))) {
    throw new TypeError('OpenClaw screening must cover every requested row');
  }
  const byRowNumber = new Map(decisions.map((decision) => [decision.rowNumber, decision]));
  return expectedRowNumbers.map((rowNumber) => byRowNumber.get(rowNumber));
}

function screeningPayload(row) {
  const payload = { rowNumber: row.rowNumber, query: row.query };
  if (row.input?.category) payload.category = row.input.category;
  if (row.input?.targetAudience) payload.targetAudience = row.input.targetAudience;
  return payload;
}

function splitRows(rows, { maxRowsPerBatch, maxDataCharacters }) {
  if (!Number.isInteger(maxRowsPerBatch) || maxRowsPerBatch < 1
    || maxRowsPerBatch > MAX_ROWS_PER_BATCH) {
    throw new RangeError(`maxRowsPerBatch must be between 1 and ${MAX_ROWS_PER_BATCH}`);
  }
  if (!Number.isInteger(maxDataCharacters) || maxDataCharacters < 500
    || maxDataCharacters > MAX_DATA_CHARACTERS) {
    throw new RangeError(`maxDataCharacters must be between 500 and ${MAX_DATA_CHARACTERS}`);
  }
  const batches = [];
  let current = [];
  for (const row of rows) {
    const candidate = [...current, screeningPayload(row)];
    if (current.length > 0
      && (candidate.length > maxRowsPerBatch || JSON.stringify(candidate).length > maxDataCharacters)) {
      batches.push(current);
      current = [screeningPayload(row)];
    } else {
      current = candidate;
    }
    if (JSON.stringify(current).length > maxDataCharacters) {
      throw new RangeError(`screening row ${row.rowNumber} exceeds the model data limit`);
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function buildScreeningPrompt(batch) {
  return businessPrompt('DEMAND_SCREENING_SYSTEM', { dataTag: 'untrusted_rows_json', data: batch,
    contract: '只返回 JSON：{"decisions":[{"rowNumber":2,"demandLevel":"STRONG","reason":"简要理由"}]}。demandLevel 为 STRONG、MEDIUM、WEAK、NONE；reason 非空且不超过 200 字；行号必须一一对应，不能缺失、重复或增加。' });
}

function normalizedModelName(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('OpenClaw screening model name is missing');
  }
  const model = value.trim();
  if ([...model].length > MAX_MODEL_NAME_CHARACTERS) {
    throw new RangeError('OpenClaw screening model name is too long');
  }
  return model;
}

export async function screenImportRowsWithOpenClaw({
  rows,
  openclaw = undefined,
  model = undefined,
  modelApi = undefined,
  maxRowsPerBatch = MAX_ROWS_PER_BATCH,
  maxDataCharacters = MAX_DATA_CHARACTERS,
}) {
  if (!Array.isArray(rows) || rows.length > 5_000) {
    throw new RangeError('import rows must be an array of at most 5000 items');
  }
  const pendingRows = rows.filter((row) => Array.isArray(row.errors)
    && row.errors.length === 0 && !row.screening);
  if (pendingRows.length === 0) return rows.map((row) => ({ ...row }));

  const rowNumbers = pendingRows.map(({ rowNumber }) => rowNumber);
  if (rowNumbers.some((rowNumber) => !Number.isInteger(rowNumber) || rowNumber < 2)
    || new Set(rowNumbers).size !== rowNumbers.length) {
    throw new TypeError('pending import row numbers are invalid');
  }

  const effectiveModelApi = effectiveModelApiConfig(modelApi ?? {});
  const screeningModel = model ?? effectiveModelApi.screeningModel;
  const client = openclaw ?? createOpenClawClient({ modelApi });
  if (!client?.runText) throw new TypeError('OpenClaw text client is required');
  const screenedByRowNumber = new Map();
  const batches = splitRows(pendingRows, { maxRowsPerBatch, maxDataCharacters });
  for (const batch of batches) {
    const prompt = buildScreeningPrompt(batch);
    const generated = await client.runText({ prompt, model: screeningModel });
    const generatedModel = normalizedModelName(generated?.model);
    const decisions = parseDemandScreeningOutput(generated?.rawText, {
      expectedRowNumbers: batch.map(({ rowNumber }) => rowNumber),
    });
    for (const decision of decisions) {
      screenedByRowNumber.set(decision.rowNumber, {
        admitted: decision.demandLevel === 'STRONG' || decision.demandLevel === 'MEDIUM',
        demandLevel: decision.demandLevel,
        reason: decision.reason,
        source: (generated.provider ?? client.provider) === 'codex' ? 'CODEX' : 'OPENCLAW',
        model: generatedModel,
      });
    }
  }

  return rows.map((row) => ({
    ...row,
    screening: row.screening ?? screenedByRowNumber.get(row.rowNumber) ?? null,
  }));
}
