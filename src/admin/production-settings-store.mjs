import {
  DEFAULT_PRODUCTION_SETTINGS,
  normalizeProductionSettings,
} from '../production-settings.mjs';

function rowToProductionSettings(row) {
  if (!row) return null;
  return {
    settings: normalizeProductionSettings(JSON.parse(row.settings_json)),
    updatedAt: row.updated_at,
  };
}

export function initializeProductionSettingsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS production_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      settings_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO production_settings (id, settings_json, updated_at)
    VALUES (1, ?, ?)
  `).run(JSON.stringify(DEFAULT_PRODUCTION_SETTINGS), createdAt);
}

export function createProductionSettingsStore(db) {
  const getRow = db.prepare('SELECT * FROM production_settings WHERE id = 1');
  return {
    getProductionSettings() {
      const settings = rowToProductionSettings(getRow.get());
      if (!settings) throw new Error('production settings are not initialized');
      return settings;
    },

    updateProductionSettings(patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new TypeError('production settings patch must be an object');
      }
      const current = this.getProductionSettings();
      const modelApi = patch.modelApi === undefined
        ? current.settings.modelApi
        : { ...current.settings.modelApi, ...patch.modelApi };
      const settings = normalizeProductionSettings({ ...current.settings, ...patch, modelApi });
      const updatedAt = new Date().toISOString();
      db.prepare(`
        UPDATE production_settings SET settings_json = ?, updated_at = ? WHERE id = 1
      `).run(JSON.stringify(settings), updatedAt);
      return { settings, updatedAt };
    },
  };
}
