import {
  ControlPlaneAuthorizationError,
  activeBlindQaSql,
  adjustTaskPriority,
  lockCurrentActor,
  normalizeTaskId,
  readOperatorPerformance,
  readPersonalQualityActivity,
  readPersonalWorkspace,
  readPriorityScope,
  transaction
} from './repository-context.mjs';
import { ExecutionRepository } from './repository-executions.mjs';

/** Statistics operations; inherited methods preserve the public repository API. */
export class StatisticsRepository extends ExecutionRepository {
  async personalWorkspace(actor, input, report = false) {
    return readPersonalWorkspace(this.pool, actor, input, {
      report, blindSql: activeBlindQaSql('task'),
      loadTasks: (client, taskIds) => new this.constructor({ pool: client }).listTasks({ taskIds, limit: 100 }),
    });
  }

  async operatorPerformance(actor, input, options = {}) {
    return readOperatorPerformance(this.pool, actor, input, options);
  }

  async personalQualityActivity(actor,input) {
    return readPersonalQualityActivity(this.pool,actor,input);
  }

  async getPriorityScope(input, { actor } = {}) {
    return transaction(this.pool, async (client) => {
      const locked = await lockCurrentActor(client, actor);
      if (locked.actor.role !== 'ADMIN') throw new ControlPlaneAuthorizationError('only administrators can inspect priority scopes');
      return readPriorityScope(client, input);
    });
  }

  async setTaskPriority(input, { actor } = {}) {
    return transaction(this.pool, async (client) => {
      const locked = await lockCurrentActor(client, actor);
      return adjustTaskPriority(client, input, locked.actor);
    });
  }

  async getTaskPriorityAudit(taskId, { actor } = {}) {
    return transaction(this.pool, async (client) => {
      const locked = await lockCurrentActor(client, actor);
      if (locked.actor.role !== 'ADMIN') throw new ControlPlaneAuthorizationError('only administrators can read priority audit');
      return (await client.query('SELECT * FROM task_priority_events WHERE task_id = $1 ORDER BY version', [normalizeTaskId(taskId)])).rows;
    });
  }
}
