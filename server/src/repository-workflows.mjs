import {
  abandonQueryPackage,
  adminDirectApproveCopyQa,
  assertTaskReadyForDelivery,
  assertTasksReadyForDelivery,
  assignQueryPackage,
  assignQueryPackageItems,
  batchReassignmentCases,
  batchReturnCopyQa,
  batchReturnImageQa,
  blockXhsQuerySearch,
  claimDeliveryPreviewRevocationJobs,
  claimXhsQuerySearch,
  closeImageSamplingTail,
  completeXhsQuerySearch,
  confirmDeliveryBatch,
  confirmDeliveryBatchMembers,
  createCopyQaReasonTag,
  createDeliveryBatch,
  createQueryPackage,
  createQueryPackageProductionBatch,
  discardDuplicateQueries,
  discardImageQaItem,
  discardReturnedCopy,
  discardTaskImages,
  disposeReassignmentCase,
  escalateQualityToAdmin,
  failDeliveryPreviewRevocationJob,
  failXhsQuerySearch,
  flushExpiredCopyQualityBatches,
  flushExpiredImageQualityBatches,
  freezeCopySamplingBatch,
  getCopyQaBatchReturnPreview,
  getCopyQaItem,
  getCopyQaStatistics,
  getDeliveryBatch,
  getDeliveryBatchArtifact,
  getDeliveryBatchSpreadsheet,
  getImageQaAsset,
  getImageQaBatchReturnPreview,
  getModelCall,
  getProductionBatchSamplingReadiness,
  getQueryPackage,
  getQueryPackageItemAssignmentSummary,
  getReassignmentCase,
  heartbeatExecutions,
  listAllDeliveryPoolTaskIds,
  listCopyQaItems,
  listCopyQaReasonTags,
  listCopyQaWorkItemsV2,
  listDeliveryBatches,
  listDeliveryPool,
  listDeliveryPoolTaskIdsForPreview,
  listImageQaItems,
  listModelCalls,
  listQueryPackages,
  listReassignmentCases,
  listXhsQuerySearchNodes,
  markDeliveryPreviewRevoked,
  passCopyQaItem,
  passImageQaItem,
  permanentlyDeleteQueryPackage,
  previewDuplicateQueryDiscard,
  previewPermanentQueryPackageDeletion,
  readWorkflowQualitySettings,
  recordDeliveryBatchDownload,
  recordDeliveryPreviewLinks,
  recoverStaleExecutions,
  regenerateReassignmentBaseline,
  releaseCopyQaFreeze,
  releaseCopySamplingBatch,
  restoreReassignmentCase,
  resumeXhsQuerySearch,
  retryFailedXhsQuerySearch,
  retryReassignmentReset,
  returnCopyQaItem,
  returnImageQaItem,
  runAutoAssignmentReplenishment,
  saveModelCall,
  submitImageSelfReview,
  taskFrom,
  transaction,
  updateCopyQaReasonTag,
  updateQueryPackageScreening,
  updateWorkflowQualitySettings
} from './repository-context.mjs';
import { NodeRepository } from './repository-nodes.mjs';

/** Existing domain workflows share commit tracking without changing read-cache identity. */
export class WorkflowRepository extends NodeRepository {
  heartbeatExecutions(input) { return heartbeatExecutions(this.factPool, input); }

  recoverStaleExecutions() { return recoverStaleExecutions(this.factPool); }

  replenishAutoAssignments(options) { return runAutoAssignmentReplenishment(this.factPool, options); }

  recordModelCall(executionId, callId, input) { return saveModelCall(this.pool, executionId, callId, input); }

  listModelCalls(taskId, options) { return listModelCalls(this.pool, taskId, options); }

  getModelCall(taskId, callId) { return getModelCall(this.pool, taskId, callId); }

  listQueryPackages(options, { actor } = {}) { return listQueryPackages(this.pool, options, actor); }

  createQueryPackage(input, { actor } = {}) { return createQueryPackage(this.factPool, input, actor); }

  getQueryPackage(id, { actor, itemPage } = {}) { return getQueryPackage(this.pool, id, actor, itemPage); }

  getQueryPackageItemAssignmentSummary(id, { actor } = {}) {
    return getQueryPackageItemAssignmentSummary(this.pool, id, actor);
  }

  assignQueryPackageItems(id, input, { actor } = {}) {
    return assignQueryPackageItems(this.factPool, id, input, actor);
  }

  assignQueryPackage(id, input, { actor } = {}) {
    return assignQueryPackage(this.factPool, id, input, actor);
  }

  updateQueryPackageScreening(id, input, { actor } = {}) {
    return updateQueryPackageScreening(this.factPool, id, input, actor);
  }

  createQueryPackageProductionBatch(id, input, { actor } = {}) {
    return createQueryPackageProductionBatch(this.factPool, id, input, actor);
  }

  permanentlyDeleteQueryPackage(id, input, { actor } = {}) {
    return permanentlyDeleteQueryPackage(this.factPool, id, input, actor);
  }

  previewPermanentQueryPackageDeletion(id, { actor } = {}) {
    return previewPermanentQueryPackageDeletion(this.pool, id, actor);
  }

  abandonQueryPackage(id, input, { actor } = {}) {
    return abandonQueryPackage(this.factPool, id, input, actor);
  }

  claimXhsQuerySearch(input) { return claimXhsQuerySearch(this.factPool, input); }

  listXhsQuerySearchNodes() { return listXhsQuerySearchNodes(this.pool); }

  completeXhsQuerySearch(id, input) { return completeXhsQuerySearch(this.factPool, id, input); }

  blockXhsQuerySearch(id, input) { return blockXhsQuerySearch(this.factPool, id, input); }

  failXhsQuerySearch(id, input) { return failXhsQuerySearch(this.factPool, id, input); }

  resumeXhsQuerySearch(input) { return resumeXhsQuerySearch(this.factPool, input); }

  retryFailedXhsQuerySearch(input) { return retryFailedXhsQuerySearch(this.factPool, input); }

  previewDuplicateQueryDiscard(input, { actor } = {}) {
    return previewDuplicateQueryDiscard(this.pool, input, actor);
  }

  discardDuplicateQueries(input, { actor } = {}) {
    return discardDuplicateQueries(this.factPool, input, actor);
  }

  getWorkflowQualitySettings() { return readWorkflowQualitySettings(this.pool); }

  updateWorkflowQualitySettings(input, { actor } = {}) {
    return updateWorkflowQualitySettings(this.pool, input, actor);
  }

  freezeCopySamplingBatch(id, input, { actor } = {}) {
    return freezeCopySamplingBatch(this.factPool, id, input, actor);
  }

  getProductionBatchSamplingReadiness(id, { actor } = {}) {
    return getProductionBatchSamplingReadiness(this.pool, id, actor);
  }

  listCopyQaItems(options, { actor } = {}) { return listCopyQaItems(this.factPool, options, actor); }

  listCopyQaWorkItemsV2(options, { actor } = {}) { return listCopyQaWorkItemsV2(this.pool, options, actor); }

  escalateQualityToAdmin(stage, id, input, { actor, storageRoot } = {}) { return escalateQualityToAdmin(this.factPool, stage, id, input, actor, { storageRoot }); }

  restoreReassignmentCase(id, input, { actor } = {}) { return restoreReassignmentCase(this.factPool, id, input, actor); }

  regenerateReassignmentBaseline(id, input, { actor } = {}) { return regenerateReassignmentBaseline(this.factPool, id, input, actor); }

  listReassignmentCases(input, { actor } = {}) { return listReassignmentCases(this.pool, input, actor); }

  getReassignmentCase(id, { actor } = {}) { return getReassignmentCase(this.pool, id, actor); }

  retryReassignmentReset(id, input, { actor, storageRoot } = {}) { return retryReassignmentReset(this.factPool, id, input, actor, { storageRoot }); }

  disposeReassignmentCase(id, input, { actor, operation } = {}) { return disposeReassignmentCase(this.factPool, id, input, actor, operation); }

  batchReassignmentCases(input, { actor, storageRoot } = {}) { return batchReassignmentCases(this.factPool, input, actor, { storageRoot }); }

  listImageQaItems(options, { actor } = {}) { return listImageQaItems(this.factPool, options, actor); }

  getImageQaAsset(itemId, assetId, { actor } = {}) {
    return getImageQaAsset(this.pool, itemId, assetId, actor);
  }

  submitImageSelfReview(taskId, input, { actor } = {}) {
    return submitImageSelfReview(this.factPool, taskId, input, actor);
  }

  passImageQaItem(id, input, { actor } = {}) { return passImageQaItem(this.factPool, id, input, actor); }

  returnImageQaItem(id, input, { actor } = {}) { return returnImageQaItem(this.factPool, id, input, actor); }

  discardTaskImages(id, input, { actor } = {}) { return discardTaskImages(this.factPool, id, input, actor); }

  discardImageQaItem(id, input, { actor } = {}) { return discardImageQaItem(this.factPool, id, input, actor); }

  getImageQaBatchReturnPreview(id, { actor } = {}) { return getImageQaBatchReturnPreview(this.pool, id, actor); }

  batchReturnImageQa(input, { actor } = {}) { return batchReturnImageQa(this.factPool, input, actor); }

  closeImageSamplingTail(input, { actor } = {}) { return closeImageSamplingTail(this.factPool, input, actor); }

  flushExpiredImageQualityBatches(options) { return flushExpiredImageQualityBatches(this.factPool, options); }

  getCopyQaItem(id, { actor } = {}) { return getCopyQaItem(this.pool, id, actor); }

  passCopyQaItem(id, input, { actor } = {}) { return passCopyQaItem(this.factPool, id, input, actor); }

  async adminDirectApproveCopyQa(id, input, { actor } = {}) {
    const result = await adminDirectApproveCopyQa(this.factPool, id, input, actor);
    return taskFrom(result.task);
  }

  returnCopyQaItem(id, input, { actor, expectedTaskId = null } = {}) {
    return returnCopyQaItem(this.factPool, id, input, actor, expectedTaskId);
  }

  async discardReturnedCopy(id, input, { actor } = {}) {
    const result = await discardReturnedCopy(this.factPool, id, input, actor);
    return taskFrom(result.task);
  }

  batchReturnCopyQa(input, { actor } = {}) { return batchReturnCopyQa(this.factPool, input, actor); }

  getCopyQaBatchReturnPreview(id, { actor } = {}) {
    return getCopyQaBatchReturnPreview(this.pool, id, actor);
  }

  getCopyQaStatistics({ actor } = {}) { return getCopyQaStatistics(this.pool, actor); }

  listCopyQaReasonTags({ actor } = {}) { return listCopyQaReasonTags(this.pool, actor); }

  createCopyQaReasonTag(input, { actor } = {}) {
    return createCopyQaReasonTag(this.pool, input, actor);
  }

  updateCopyQaReasonTag(id, input, { actor } = {}) {
    return updateCopyQaReasonTag(this.pool, id, input, actor);
  }

  releaseCopyQaFreeze(id, input, { actor } = {}) {
    return releaseCopyQaFreeze(this.factPool, id, input, actor);
  }

  assertTaskReadyForDelivery(id) { return assertTaskReadyForDelivery(this.pool, id); }

  assertTasksReadyForDelivery(bindings) {
    return assertTasksReadyForDelivery(this.pool, bindings);
  }

  listDeliveryPool(options, { actor } = {}) { return listDeliveryPool(this.pool, options, actor); }

  listAllDeliveryPoolTaskIds({ actor, queryPackageName = null, clientBatchCode = null,
    unpackedOnly = false } = {}) {
    return listAllDeliveryPoolTaskIds(this.pool, actor, {
      queryPackageName, clientBatchCode, unpackedOnly,
    });
  }

  createDeliveryBatch(input, { actor } = {}) {
    return transaction(this.pool, (client) => createDeliveryBatch(client, input, actor));
  }

  listDeliveryBatches(options, { actor } = {}) {
    return listDeliveryBatches(this.pool, options, actor);
  }

  getDeliveryBatch(id, { actor } = {}) {
    return getDeliveryBatch(this.pool, id, actor);
  }

  getDeliveryBatchSpreadsheet(id, { actor } = {}) {
    return getDeliveryBatchSpreadsheet(this.pool, id, actor);
  }

  getDeliveryBatchArtifact(id, { actor } = {}) {
    return getDeliveryBatchArtifact(this.pool, id, actor);
  }

  recordDeliveryBatchDownload(id, { actor } = {}) {
    return transaction(this.pool, (client) => recordDeliveryBatchDownload(client, id, actor));
  }

  confirmDeliveryBatch(id, { actor } = {}) {
    return transaction(this.pool, async (client) => {
      await confirmDeliveryBatchMembers(client, id, actor);
      return confirmDeliveryBatch(client, id, actor);
    });
  }

  listDeliveryPoolTaskIdsForPreview({
    actor, queryPackageIds, includeUnassigned = false, taskIds = [], testTaskId = null, limit = 50,
  } = {}) {
    return listDeliveryPoolTaskIdsForPreview(this.pool, actor, {
      queryPackageIds, includeUnassigned, taskIds, testTaskId, limit,
    });
  }

  recordDeliveryPreviewLinks(records, actor) {
    return transaction(this.pool, (client) => recordDeliveryPreviewLinks(client, records, actor));
  }

  markDeliveryPreviewRevoked(previewId, revokedAt) {
    return transaction(this.pool, (client) => markDeliveryPreviewRevoked(client, previewId, revokedAt));
  }

  claimDeliveryPreviewRevocationJobs(limit = 10) {
    return claimDeliveryPreviewRevocationJobs(this.pool, limit);
  }

  failDeliveryPreviewRevocationJob(jobId, error) {
    return failDeliveryPreviewRevocationJob(this.pool, jobId, error);
  }

  releaseCopySamplingBatch(id, input, { actor } = {}) {
    return releaseCopySamplingBatch(this.factPool, id, input, actor);
  }

  async flushExpiredCopyQualityBatches() {
    return flushExpiredCopyQualityBatches(this.factPool);
  }
}
