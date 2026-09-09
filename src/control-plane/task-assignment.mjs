export const CREATE_ASSIGNMENT_MODES = Object.freeze({
  SELF: 'SELF',
  MANUAL: 'MANUAL',
  UNASSIGNED: 'UNASSIGNED',
});

export function createAssignmentFields({ role, mode, assigneeUserId, assigneeAccountId }) {
  if (role !== 'ADMIN') return {};
  if (mode === CREATE_ASSIGNMENT_MODES.UNASSIGNED) {
    return { assignedToUserId: null, assignedToAccountId: null };
  }
  if (mode !== CREATE_ASSIGNMENT_MODES.MANUAL) throw new TypeError('管理员必须选择任务分配方式');
  if (typeof assigneeUserId !== 'string' || !assigneeUserId.trim()) {
    throw new TypeError('请选择有效的作业员');
  }
  if (!Number.isSafeInteger(assigneeAccountId) || assigneeAccountId < 1) {
    throw new TypeError('请选择有效的作业员账号');
  }
  return {
    assignedToUserId: assigneeUserId.trim().toLowerCase(),
    assignedToAccountId: assigneeAccountId,
  };
}

export function selectedTasksHaveMixedAssignees(tasks) {
  if (!Array.isArray(tasks) || tasks.length < 2) return false;
  const firstAssignee = tasks[0]?.assignedToUserId ?? null;
  const firstAccountId = tasks[0]?.assignedToAccountId ?? null;
  return tasks.some((task) => (task?.assignedToUserId ?? null) !== firstAssignee
    || (task?.assignedToAccountId ?? null) !== firstAccountId);
}
