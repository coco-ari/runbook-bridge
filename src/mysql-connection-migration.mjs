import { migrateMysqlRecords, mysqlConnectionCredentialId } from './mysql-connection-profile.mjs';
import { AppError } from './errors.mjs';

export async function migrateMysqlConnections(store,vault,transaction,guard = transaction) {
  const result = {migrated:0,blockedProjects:[]};
  for (const project of await store.listProjects()) {
    try {
      for (const environmentId of project.environmentOrder) {
        guard.assertEnvironmentAvailable(project.projectId,environmentId);
        await store.enqueue(`environment:${project.projectId}:${environmentId}`,async () => {
          const environment = await store.getEnvironment(project.projectId,environmentId);
          const plugins = (await store.listPlugins(project.projectId,environmentId)).filter(plugin => plugin.pluginType === 'mysql' && !plugin.mysqlConnectionId && plugin.configState !== 'draft');
          if (!plugins.length) return;
          const records = [];
          for (const plugin of plugins) records.push({plugin,secrets:await vault.load(plugin) ?? {}});
          const migrated = migrateMysqlRecords(records,environment.mysqlConnections ?? []);
          const originalIds = plugins.map(plugin => plugin.pluginInstanceId);
          const ids = migrated.records.map(({plugin}) => plugin.pluginInstanceId);
          const added = ids.filter(id => !originalIds.includes(id));
          if (new Set(ids).size !== ids.length || added.some(id => environment.pluginOrder.includes(id)) || environment.pluginOrder.length + added.length > 100) throw new AppError('MYSQL_CONNECTION_INVALID','迁移数据库数量超过限制或标识冲突，原配置已保留。');
          const credentialIds = [...ids,...new Set(migrated.records.map(({plugin}) => mysqlConnectionCredentialId(plugin.mysqlConnectionId)))];
          const before = await transaction.snapshot(project.projectId,environmentId,ids,credentialIds);
          if (added.some(id => before.files[`environments/${environmentId}/plugins/${id}.yaml`])) throw new AppError('MYSQL_CONNECTION_INVALID','迁移目标文件已存在，原配置已保留。');
          // 加密事务在改写前自动保留完整备份，失败或中断时恢复原配置与凭据。
          await transaction.commitPlugins(before,migrated.records.map(({plugin}) => ({...plugin,revision:plugin.revision+1})),migrated.records,
            {connections:migrated.connections,removeCredentialIds:originalIds,creating:added.length > 0});
          result.migrated += plugins.length;
        });
      }
    } catch {
      // 无法读取凭据或存在未完成事务时隔离项目，不能带病迁移或覆盖原配置。
      transaction.blocked.add(project.projectId);
      result.blockedProjects.push(project.projectId);
    }
  }
  return result;
}
