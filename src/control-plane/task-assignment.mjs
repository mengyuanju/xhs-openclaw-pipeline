export const CREATE_ASSIGNMENT_MODES = Object.freeze({
  SELF: 'SELF',
  MANUAL: 'MANUAL',
  UNASSIGNED: 'UNASSIGNED',
});

export function createAssignmentFields({ role, mode, assigneeUserId }) {
  if (role !== 'ADMIN') return {};
  if (mode === CREATE_ASSIGNMENT_MODES.UNASSIGNED) return { assignedToUserId: null };
  if (mode !== CREATE_ASSIGNMENT_MODES.MANUAL) throw new TypeError('管理员必须选择任务分配方式');
  if (typeof assigneeUserId !== 'string' || !assigneeUserId.trim()) {
    throw new TypeError('请选择有效的作业员');
  }
  return { assignedToUserId: assigneeUserId.trim().toLowerCase() };
}
