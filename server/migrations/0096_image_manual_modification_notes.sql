ALTER TABLE image_approval_events
  ADD COLUMN manual_modification_note text
    CHECK (manual_modification_note IS NULL OR char_length(manual_modification_note) <= 1000);
