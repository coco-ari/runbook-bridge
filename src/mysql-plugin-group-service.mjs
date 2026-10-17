import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AppError, toPublicError } from './errors.mjs';
import { normalizePlugin } from './plugin-config-model.mjs';
import { assertPluginConfigurationReady } from './plugin-connection-adapters.mjs';
import { isolateNewPluginIdentity } from './plugin-creation-identity.mjs';
import { mysqlPluginGroup, mysqlGroupMembers, normalizeBatchDatabases } from './mysql-plugin-group.mjs';
import { bindMysqlConnection, createMysqlConnection, mysqlConnectionCredentialId } from './mysql-connection-profile.mjs';

export function createMysqlPluginGroupService(services,hooks) {
  const {workspaceStore:store,credentialVault:vault,pluginBatchTransaction:transaction,mutationCoordinator,connectionManager,contextManager,confirmationManager} = services;
  const enqueue = (scope,operation,ownerId = null) => mutationCoordinator.enqueueEnvironmentMutation(scope.projectId,scope.environmentId,operation,{ownerId});
  const scoped = (scope,operation) => store.enqueue(`environment:${scope.projectId}:${scope.environmentId}`,operation);
  const membersFor = async scope => {
    const plugin = await store.getPlugin(scope.projectId,scope.environmentId,scope.pluginInstanceId);
    const members = mysqlGroupMembers(plugin,await store.listPlugins(scope.projectId,scope.environmentId));
    if (!plugin.mysqlConnectionId || !members.length) throw new AppError('MYSQL_CONNECTION_NOT_FOUND','MySQL 连接尚未迁移或已不存在，请重启并刷新。');
    const environment = await store.getEnvironment(scope.projectId,scope.environmentId);
    const connection = environment.mysqlConnections.find(item => item.connectionId === plugin.mysqlConnectionId);
    return {plugin,members,environment,connection};
  };
  const describe = async scope => {
    const {plugin,members,connection} = await membersFor(scope);
    return {...mysqlPluginGroup(plugin),revision:connection.revision,
      members:members.map(item => ({pluginInstanceId:item.pluginInstanceId,displayName:item.displayName,database:item.target.database,revision:item.revision})),
      connectionInconsistent:false,credentialsInconsistent:false,credentialsUnreadable:false};
  };
  const notify = async (scope,plugins,type) => {
    let runtimeWarning = null;
    for (const plugin of plugins) {
      try { const result = await connectionManager.configurationChanged(scope.projectId,scope.environmentId,plugin.pluginInstanceId); runtimeWarning ??= result?.runtimeWarning ?? null; }
      catch (error) { runtimeWarning ??= toPublicError(error); }
      confirmationManager.invalidatePlugin?.(scope.projectId,scope.environmentId,plugin.pluginInstanceId);
      await hooks.recordPluginChange(plugin,type);
    }
    contextManager.invalidateEnvironment?.(scope.projectId,scope.environmentId);
    return runtimeWarning;
  };
  const capture = (scope,plugins,connections) => {
    if (!transaction) throw new AppError('PLUGIN_BATCH_UNAVAILABLE','MySQL 连接保存服务不可用。');
    const ids = [...new Set(plugins.map(item => item.pluginInstanceId))];
    const credentials = [...new Set([...ids,...connections.map(item => mysqlConnectionCredentialId(item.connectionId))])];
    return transaction.snapshot(scope.projectId,scope.environmentId,ids,credentials);
  };
  const validate = async plugins => {
    for (const plugin of plugins) { assertPluginConfigurationReady(plugin); await store.assertPluginReferences(plugin); }
  };
  const create = payload => enqueue(payload,() => hooks.withConfigurationMutation(payload.projectId,payload.environmentId,null,async ({restoreOnFailure}) => {
    let plugins;
    let committed;
    try {
      committed = await scoped(payload,async () => {
        const databases = normalizeBatchDatabases(payload.databases);
        if (payload.input?.pluginType !== 'mysql') throw new AppError('INVALID_ARGUMENT','此入口仅支持 MySQL。');
        const environment = await store.getEnvironment(payload.projectId,payload.environmentId);
        if (environment.pluginOrder.length + databases.length > 100) throw new AppError('RESULT_LIMIT_EXCEEDED','每个环境最多 100 个插件，请减少选择。');
        const base = normalizePlugin({...payload.input,mysqlConnectionId:undefined,target:{...payload.input.target,database:databases[0]}},payload);
        const connection = createMysqlConnection(base,{name:payload.groupName?.trim() || base.displayName});
        plugins = [];
        for (const [index,database] of databases.entries()) {
          let plugin = normalizePlugin({...payload.input,mysqlConnectionId:undefined,
            pluginInstanceId:index === 0 ? payload.input.pluginInstanceId ?? `mysql-${crypto.randomUUID()}` : `mysql-${crypto.randomUUID()}`,
            displayName:databases.length === 1 ? base.displayName : `${connection.name} · ${database}`.slice(0,120),target:{...payload.input.target,database}},payload);
          plugin = await isolateNewPluginIdentity(plugin,{workspaceStore:store,credentialVault:vault,explicitIdentity:true});
          plugins.push(bindMysqlConnection(plugin,connection));
        }
        await validate(plugins);
        const before = await capture(payload,plugins,[connection]);
        if (plugins.some(plugin => environment.pluginOrder.includes(plugin.pluginInstanceId) || before.files[`environments/${payload.environmentId}/plugins/${plugin.pluginInstanceId}.yaml`])) throw new AppError('PLUGIN_ALREADY_EXISTS','插件标识已经存在，请刷新后重试。');
        return transaction.commitPlugins(before,plugins,[{plugin:plugins[0],secrets:payload.secrets ?? {}}],{creating:true,connections:[...(environment.mysqlConnections ?? []),connection]});
      });
    } catch (error) { restoreOnFailure(); throw error; }
    return {committed:true,plugin:plugins[0],plugins,createdCount:plugins.length,groupId:plugins[0].mysqlConnectionId,runtimeWarning:await notify(payload,plugins,'plugin-added'),
      ...(committed.cleanupPending ? {persistenceWarning:{code:'CONFIG_TRANSACTION_RECOVERY_REQUIRED',message:'连接已保存，恢复记录清理待重启完成。'}} : {})};
  }));

  // 编辑会话已经暂停全部成员；成员增减、公共配置和凭据在同一加密事务中保存。
  const save = async (payload,material,prepared) => hooks.withConfigurationMutation(payload.projectId,payload.environmentId,null,async ({restoreOnFailure}) => {
    let plugins;
    let committed;
    try {
      committed = await scoped(payload,async () => {
        const {plugin,members,environment,connection} = await membersFor(payload);
        if (!Array.isArray(material.mysqlGroupMembers) || !isDeepStrictEqual(members,material.mysqlGroupMembers)) throw new AppError('CONFIG_REVISION_CONFLICT','连接或数据库成员已变化，请重新打开编辑。');
        if (payload.applyToMysqlGroup !== true) throw new AppError('MYSQL_GROUP_EDIT_REQUIRED','请在 MySQL 连接设置中修改公共配置。');
        const databases = payload.databases === undefined ? members.map(item => item.target.database) : normalizeBatchDatabases(payload.databases);
        if (prepared.after.target.database !== plugin.target.database) throw new AppError('INVALID_ARGUMENT','请通过管理数据库增减成员，不可改写现有数据库身份。');
        const {secrets,existingSecrets,discardedCause} = await vault.prepareSecretsUpdate(plugin,prepared.after,prepared.replacements,
          {forceCredentialReplacement:prepared.forceCredentialReplacement});
        if (discardedCause && members.some(member => !databases.includes(member.target.database))) {
          throw new AppError('MYSQL_GROUP_CREDENTIAL_RECOVERY_REQUIRED','旧凭据无法读取，不能保留移出数据库的原凭据。请先保留全部数据库并完成凭据替换，再取消关联。');
        }
        const nextConnection = createMysqlConnection(prepared.after,{id:connection.connectionId,name:payload.connectionName ?? connection.name,revision:connection.revision+1});
        const connections = environment.mysqlConnections.map(item => item.connectionId === connection.connectionId ? nextConnection : item);
        plugins = [];
        const credentials = [];
        for (const member of members) {
          const updated = {...member,revision:member.revision+1,updatedAt:new Date().toISOString()};
          if (databases.includes(member.target.database)) plugins.push(bindMysqlConnection(updated,nextConnection));
          else {
            // 取消关联只移出当前连接，保留单库身份、配置和凭据。
            const independent = createMysqlConnection(member);
            connections.push(independent);
            const detached = bindMysqlConnection(updated,independent);
            plugins.push(detached);
            credentials.push({plugin:detached,secrets:existingSecrets});
          }
        }
        const added = databases.filter(database => !members.some(item => item.target.database === database));
        if (environment.pluginOrder.length + added.length > 100) throw new AppError('RESULT_LIMIT_EXCEEDED','每个环境最多 100 个插件。');
        for (const database of added) {
          const child = normalizePlugin({...plugin,pluginInstanceId:`mysql-${crypto.randomUUID()}`,displayName:database,target:{...nextConnection.target,database}},payload);
          plugins.push(bindMysqlConnection(child,nextConnection));
        }
        await validate(plugins);
        credentials.push({plugin:plugins.find(item => item.mysqlConnectionId === connection.connectionId),secrets});
        const touched = connections.filter(item => item.connectionId === connection.connectionId || !environment.mysqlConnections.some(old => old.connectionId === item.connectionId));
        const before = await capture(payload,plugins,touched);
        for (const child of plugins.filter(item => !members.some(old => old.pluginInstanceId === item.pluginInstanceId))) {
          if (before.files[`environments/${payload.environmentId}/plugins/${child.pluginInstanceId}.yaml`]) throw new AppError('PLUGIN_ALREADY_EXISTS','新数据库插件标识已存在。');
        }
        return transaction.commitPlugins(before,plugins,credentials,{creating:true,connections});
      });
    } catch (error) { restoreOnFailure(); throw error; }
    return {plugin:plugins.find(item => item.pluginInstanceId === payload.pluginInstanceId),updatedCount:plugins.length,runtimeWarning:await notify(payload,plugins,'plugin-connection-updated'),
      persistenceWarning:committed.cleanupPending ? {code:'CONFIG_TRANSACTION_RECOVERY_REQUIRED',message:'连接已保存，恢复记录待清理。'} : null};
  },payload.editSessionId);
  const detach = payload => enqueue(payload,async () => {
    const {plugin,members,connection,environment} = await membersFor(payload);
    (services.assertScopeIdle ?? (scope => services.v2Service?.mysqlSql?.assertScopeIdle(scope)))(payload);
    const phase = connectionManager.snapshot?.(payload.projectId,payload.environmentId)?.plugins?.[plugin.pluginInstanceId]?.phase;
    if (phase && !['disconnected','error','blocked'].includes(phase)) throw new AppError('PLUGIN_EDIT_SESSION_REQUIRED','请在连接编辑的管理数据库中取消关联，或先断开此库。');
    if (plugin.revision !== payload.expectedRevision) throw new AppError('CONFIG_REVISION_CONFLICT','插件已变化，请刷新。');
    if (members.length === 1) return plugin;
    const independent = createMysqlConnection(plugin);
    const detached = bindMysqlConnection({...plugin,revision:plugin.revision+1,updatedAt:new Date().toISOString()},independent);
    const before = await capture(payload,[plugin],[connection,independent]);
    await transaction.commitPlugins(before,[detached],[{plugin:detached,secrets:await vault.load(plugin) ?? {}}],{connections:[...environment.mysqlConnections,independent]});
    await notify(payload,[detached],'plugin-connection-updated');
    return detached;
  });
  const remove = payload => enqueue(payload,() => scoped(payload,async () => {
    const {members,connection,environment} = await membersFor(payload);
    const expected = payload.expectedMembers;
    if (!Array.isArray(expected) || !expected.length || expected.length > 100
      || expected.some(item => !item || typeof item.pluginInstanceId !== 'string' || !Number.isSafeInteger(item.revision) || item.revision < 1)
      || new Set(expected.map(item => item.pluginInstanceId)).size !== expected.length
      || typeof payload.expectedConnectionId !== 'string' || !Number.isSafeInteger(payload.expectedRevision)) {
      throw new AppError('INVALID_ARGUMENT','删除数据库组需要完整的连接与成员确认信息。');
    }
    const versions = items => items.map(({pluginInstanceId,revision}) => ({pluginInstanceId,revision})).sort((a,b) => a.pluginInstanceId.localeCompare(b.pluginInstanceId));
    if (payload.expectedConnectionId !== connection.connectionId || payload.expectedRevision !== connection.revision
      || !isDeepStrictEqual(versions(expected),versions(members))) {
      throw new AppError('CONFIG_REVISION_CONFLICT','数据库组或成员已变化，请重新打开删除确认。');
    }
    for (const member of members) await store.preflightDeletePlugin(payload.projectId,payload.environmentId,member.pluginInstanceId);
    return hooks.withConfigurationMutation(payload.projectId,payload.environmentId,null,async ({restoreOnFailure}) => {
      let committed;
      try {
        const before = await capture(payload,members,[connection]);
        // 索引、连接与成员配置原子删除；凭据沿用单插件删除的保留策略。
        committed = await transaction.commitPlugins(before,[],[],{
          connections:environment.mysqlConnections.filter(item => item.connectionId !== connection.connectionId),
          removePluginIds:members.map(item => item.pluginInstanceId),
        });
      } catch (error) { restoreOnFailure(); throw error; }
      let runtimeWarning = await notify(payload,members,'plugin-deleted');
      for (const member of members) {
        services.legacyCredentialStore?.invalidatePlugin(payload.projectId,payload.environmentId,member.pluginInstanceId);
        try {
          if (typeof connectionManager.disconnectRuntime === 'function') await connectionManager.disconnectRuntime(member,'plugin-delete');
          else await services.pluginManager?.disconnect(member,'plugin-delete');
        } catch (error) { runtimeWarning ??= toPublicError(error); }
        services.broadcast?.('v2:workspace-changed',{type:'plugin-deleted',projectId:payload.projectId,environmentId:payload.environmentId,pluginInstanceId:member.pluginInstanceId});
      }
      return {committed:true,deletedPluginInstanceIds:members.map(item => item.pluginInstanceId),deletedCount:members.length,credentialsPreserved:true,
        ...(runtimeWarning ? {runtimeWarning} : {}),
        ...(committed.cleanupPending ? {persistenceWarning:{code:'CONFIG_TRANSACTION_RECOVERY_REQUIRED',message:'数据库组已删除，恢复记录待重启清理。'}} : {})};
    });
  }));
  const connect = async payload => {
    const {members} = await membersFor(payload);
    if (!['connect','disconnect'].includes(payload.intent)) throw new AppError('INVALID_ARGUMENT','连接操作无效。');
    if (payload.intent === 'disconnect') {
      // 现有断开入口以单个插件为范围；不能将数组交给环境级断开而影响其他资源。
      const actions = [];
      for (const member of members) {
        try { await connectionManager.requestConnectionIntent({projectId:payload.projectId,environmentId:payload.environmentId,pluginInstanceId:member.pluginInstanceId,intent:'disconnect',requestId:crypto.randomUUID(),source:'mysql-connection'}); }
        catch (error) { actions.push({pluginInstanceId:member.pluginInstanceId,error:toPublicError(error)}); }
      }
      return {outcome:actions.length ? 'blocked' : 'started',actions,snapshot:connectionManager.snapshot?.(payload.projectId,payload.environmentId)};
    }
    return connectionManager.requestConnectionIntent({projectId:payload.projectId,environmentId:payload.environmentId,pluginInstanceIds:members.map(item => item.pluginInstanceId),
      intent:payload.intent,requestId:crypto.randomUUID(),source:'mysql-connection'});
  };
  return {create,save,describe,detach,connect,remove};
}
