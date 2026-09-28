-- A single image run may have several submissions. Bind reporting facts to one
-- approval, keeping sampling-item identity when available and otherwise using
-- the latest submission that existed when the historical action occurred.
-- Existing append-only facts are deliberately neither recaptured nor updated.
CREATE OR REPLACE VIEW operator_source_facts AS
SELECT 'copy-submit:'||a.id AS event_key,a.task_id,a.approved_by_account_id AS account_id,'COPY'::text AS stage,
  'SUBMIT'::text AS kind,a.approved_at AS occurred_at,
  jsonb_build_object('username',a.approved_by_username,'copyRevisionId',a.copy_revision_id,
    'approvalId',a.id,'exclusion',CASE WHEN a.approval_mode='ADMIN_BYPASS' THEN 'BYPASS' END,
    'rework',r.revision_origin IN ('QA_RETURN','FINAL_REWORK') OR COALESCE(r.copy_rework_satisfied,false),
    'firstSubmission',NOT EXISTS(SELECT 1 FROM copy_approval_events p WHERE p.task_id=a.task_id AND (p.approved_at,p.id)<(a.approved_at,a.id))) AS data
FROM copy_approval_events a JOIN copy_revisions r ON r.id=a.copy_revision_id
UNION ALL
SELECT 'image-submit:'||a.id,a.task_id,a.submitted_by_account_id,'IMAGE','SUBMIT',a.submitted_at,
  jsonb_build_object('username',a.submitted_by_username,'copyRevisionId',a.copy_revision_id,'imageRunId',a.image_run_id,
    'approvalId',a.id,'exclusion',CASE WHEN r.result->'simulation'->>'enabled'='true' THEN 'SIMULATED' END,
    'rework',a.submission_mode='MANDATORY_RECHECK',
    'firstSubmission',NOT EXISTS(SELECT 1 FROM image_approval_events p WHERE p.task_id=a.task_id AND (p.submitted_at,p.id)<(a.submitted_at,a.id)))
FROM image_approval_events a JOIN image_runs r ON r.id=a.image_run_id
UNION ALL
SELECT lower(q.stage)||'-qa:'||q.id,q.task_id,q.account_id,q.stage,'QUALITY',q.decided_at,
  jsonb_build_object('username',q.username,'copyRevisionId',q.copy_revision_id,'imageRunId',q.image_run_id,
    'approvalId',q.approval_event_id,'samplingItemId',q.id,'sampleKind',q.sample_kind,'first',q.first_random AND q.sample_kind='RANDOM',
    'firstRecheck',q.sample_kind='MANDATORY_RECHECK' AND CASE WHEN q.stage='COPY' THEN
      EXISTS(SELECT 1 FROM copy_sampling_items parent WHERE parent.id=q.parent_item_id AND parent.sample_kind='RANDOM') ELSE
      EXISTS(SELECT 1 FROM image_sampling_items parent WHERE parent.id=q.parent_item_id AND parent.sample_kind='RANDOM') END,
    'outcome',q.outcome,'exclusion',q.exclusion,'reasons',q.reason_codes,'target',q.rework_target,
    'reviewerId',COALESCE(q.reviewer_id,q.reviewed_by_account_id),'submittedAt',q.submitted_at,'policyVersion',q.policy_version)
FROM operator_quality_samples q WHERE q.outcome IS NOT NULL AND q.decided_at IS NOT NULL
UNION ALL
SELECT lower(q.stage)||'-sample:'||q.id,q.task_id,q.account_id,q.stage,'SAMPLE',q.created_at,
  jsonb_build_object('username',q.username,'approvalId',q.approval_event_id,'samplingItemId',q.id,
    'sampleKind',q.sample_kind,'first',q.first_random,'selected',q.selected,'policyVersion',q.policy_version)
FROM operator_quality_samples q
UNION ALL
SELECT 'final-return:'||h.id,h.task_id,a.submitted_by_account_id,'IMAGE','RETURN',h.created_at,
  jsonb_build_object('username',a.submitted_by_username,'copyRevisionId',h.copy_revision_id,'imageRunId',h.image_run_id,
    'approvalId',a.id,'reasons',h.reason_codes,'target',h.rework_target,'source','FINAL_REWORK')
FROM human_quality_assessments h LEFT JOIN LATERAL (
  SELECT approval.* FROM image_approval_events approval
  WHERE approval.task_id=h.task_id AND approval.image_run_id=h.image_run_id
    AND (h.copy_revision_id IS NULL OR approval.copy_revision_id=h.copy_revision_id)
    AND approval.submitted_at<=h.created_at
  ORDER BY approval.submitted_at DESC,approval.id DESC LIMIT 1
) a ON true
WHERE h.rework_target IS NOT NULL
UNION ALL
SELECT lower(q.stage)||'-batch-impact:'||q.id,q.task_id,q.account_id,q.stage,'BATCH_RETURN',COALESCE(q.batch_returned_at,q.reviewed_at,q.created_at),
  jsonb_build_object('username',q.username,'copyRevisionId',q.copy_revision_id,'imageRunId',q.image_run_id,'reasons',q.reason_codes,
    'target',COALESCE(q.rework_target,q.stage),'exclusion',q.exclusion)
FROM operator_quality_samples q WHERE q.status IN ('BATCH_AFFECTED','BATCH_RETURNED') OR q.action='RETURN_BATCH'
UNION ALL
SELECT 'release:'||d.id,d.task_id,a.submitted_by_account_id,'IMAGE','RELEASE',d.approved_at,
  jsonb_build_object('username',a.submitted_by_username,'copyRevisionId',d.copy_revision_id,'imageRunId',d.image_run_id,
    'approvalId',a.id,'exclusion',CASE WHEN a.id IS NULL THEN 'UNKNOWN_IDENTITY' WHEN r.result->'simulation'->>'enabled'='true' THEN 'SIMULATED' END,
    'first',NOT EXISTS(SELECT 1 FROM delivery_entries p WHERE p.task_id=d.task_id AND (p.approved_at,p.id)<(d.approved_at,d.id)),
    'releaseMethod',CASE WHEN EXISTS(SELECT 1 FROM image_sampling_items i WHERE i.approval_event_id=a.id AND i.status='PASSED') THEN 'INSPECTED' ELSE 'POLICY_RELEASE' END)
FROM delivery_entries d LEFT JOIN LATERAL (
  SELECT approval.* FROM image_approval_events approval
  WHERE approval.task_id=d.task_id AND approval.image_run_id=d.image_run_id
    AND approval.copy_revision_id=d.copy_revision_id AND approval.submitted_at<=d.approved_at
  ORDER BY approval.submitted_at DESC,approval.id DESC LIMIT 1
) a ON true LEFT JOIN image_runs r ON r.id=d.image_run_id
UNION ALL
SELECT 'delivered:'||b.id||':'||i.id,i.task_id,b.delivered_by_account_id,'IMAGE','DELIVERY',b.delivered_at,
  jsonb_build_object('username',b.delivered_by_username,'copyRevisionId',i.copy_revision_id,'imageRunId',i.image_run_id,
    'deliveryBatchId',b.id,'query',i.query_snapshot)
FROM delivery_batches b JOIN delivery_batch_items i ON i.delivery_batch_id=b.id WHERE b.status='DELIVERED';

CREATE OR REPLACE VIEW account_quality_disposition_sources AS
SELECT 'copy-disposition:'||d.id AS event_key,d.task_id,'COPY'::text AS stage,COALESCE(a.approved_by_account_id,i.final_approver_account_id) AS account_id,
  'DISCARD'::text AS action,false AS establishes_sample,d.created_at AS occurred_at,
  jsonb_build_object('username',COALESCE(a.approved_by_username,i.final_approver_username),'samplingItemId',i.id,'actorId',d.actor_account_id,
    'reason',d.reason_code,'note',d.note,'source','COPY_DISPOSITION') AS data
FROM copy_return_dispositions d JOIN copy_sampling_items i ON i.id=d.source_sampling_item_id
LEFT JOIN copy_approval_events a ON a.id=i.approval_event_id
UNION ALL
SELECT 'image-disposition:'||d.id,d.task_id,'IMAGE',a.submitted_by_account_id,'DISCARD',
  (d.from_state='IMAGE_QC_PENDING' AND COALESCE(i.selected,false)
    AND d.actor_account_id<>a.submitted_by_account_id AND NOT COALESCE(r.result->'simulation'->>'enabled'='true',false)),d.created_at,
  jsonb_build_object('username',a.submitted_by_username,'samplingItemId',i.id,'approvalId',a.id,'actorId',d.actor_account_id,
    'reviewerId',d.actor_account_id,'note',d.note,'source','IMAGE_DISPOSITION',
    'query',t.query,'batchId',t.production_batch_id,'copyRevisionId',d.copy_revision_id,'imageRunId',d.image_run_id)
FROM image_task_dispositions d
LEFT JOIN image_sampling_items i ON i.id=d.sampling_item_id AND i.task_id=d.task_id
  AND i.copy_revision_id=d.copy_revision_id AND i.image_run_id=d.image_run_id
JOIN LATERAL (
  SELECT approval.* FROM image_approval_events approval
  WHERE approval.task_id=d.task_id AND approval.image_run_id=d.image_run_id
    AND approval.copy_revision_id=d.copy_revision_id
    AND ((d.sampling_item_id IS NOT NULL AND approval.id=i.approval_event_id)
      OR (d.sampling_item_id IS NULL AND approval.submitted_at<=d.created_at))
  ORDER BY approval.submitted_at DESC,approval.id DESC LIMIT 1
) a ON true JOIN image_runs r ON r.id=d.image_run_id
JOIN tasks t ON t.id=d.task_id
WHERE NOT COALESCE(r.result->'simulation'->>'enabled'='true',false);
