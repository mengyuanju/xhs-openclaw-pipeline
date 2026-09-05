-- NULL preserves any legacy UUIDv4 receipt; new UUIDv7 requests always set expiry.
ALTER TABLE execution_claim_requests ADD COLUMN expires_at timestamptz;
CREATE INDEX execution_claim_requests_expiry_idx
  ON execution_claim_requests(node_id, kind, expires_at);
