/**
 * Keep a manual choice while it is online; otherwise use the lowest copy load.
 * Image work does not affect the independent copy lane. Ties keep list order.
 * @template {{ id: string, online: boolean, copyQueuedCount: number, copyRunningCount: number }} T
 * @param {T[]} nodes
 * @param {string} [preferredNodeId]
 * @returns {T | null}
 */
export function selectCopyExecutor(nodes, preferredNodeId = '') {
  let selected = null;
  let lowestLoad = Infinity;
  for (const node of nodes) {
    if (!node.online) continue;
    if (node.id === preferredNodeId) return node;
    const load = node.copyQueuedCount + node.copyRunningCount;
    if (load < lowestLoad) {
      selected = node;
      lowestLoad = load;
    }
  }
  return selected;
}
