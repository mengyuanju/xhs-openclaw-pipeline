ALTER TABLE query_package_items
  ADD COLUMN issued_query text
  CHECK (issued_query IS NULL OR char_length(issued_query) <= 5000);

COMMENT ON COLUMN query_package_items.issued_query IS '原始下发 Query；历史未保存的记录为空，query 保存实际生产内容';
