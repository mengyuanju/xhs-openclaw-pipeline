CREATE INDEX query_package_items_package_status_row_idx
  ON query_package_items(query_package_id, status, row_number, id);

CREATE INDEX query_package_items_package_decision_row_idx
  ON query_package_items(query_package_id, screening_decision, row_number, id);
