import crypto from 'node:crypto';
import { AppError, toPublicError } from './errors.mjs';
import { pluginConnectionFingerprint } from './plugin-change-classifier.mjs';

const VALID_INTENTS = new Set(['connect','disconnect','retry','cancel']);
const HISTORY_LIMIT = 512;
const CONNECTION_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CONNECTION_CHALLENGE_LIMIT = 256;

function operationKey(projectId,environmentId,pluginInstanceId) {
  return `${projectId}/${environmentId}/${pluginInstanceId}`;
}

function runtimePluginState(plugin,phase = 'disconnected',extra = {}) {
  return {
    pluginInstanceId:plugin.pluginInstanceId,
    pluginType:plugin.pluginType,
    displayName:plugin.displayName,
    providerPluginInstanceId:plugin.transport?.kind === 'serverTunnel'
      ? plugin.transport.serverPluginInstanceId ?? null
      : null,
    phase,
    reason:null,
    retryable:false,
    attempt:0,
    updatedAt:new Date().toISOString(),
    ...extra,
  };
}

function terminalConnectionError(error) {
  return new Set([
    'AUTHENTICATION_FAILED','SSH_AUTH_FAILED','SSH_HOST_KEY_CHANGED','SSH_HOST_KEY_CONFIRM_REQUIRED',
    'TLS_IDENTITY_FAILED','TLS_CERTIFICATE_INVALID','TLS_PROTOCOL_ERROR','TLS_NOT_SUPPORTED',
    'MYSQL_TLS_NOT_SUPPORTED','CREDENTIAL_UNAVAILABLE','CREDENTIAL_BINDING_MISMATCH',
    'PLUGIN_CONFIG_INCOMPLETE','MANUAL_RECONNECT_REQUIRED',
  ]).has(error?.code);
}

function publicAction({rootPluginInstanceId,affectedPluginInstanceIds,code,message,action = 'configure',details}) {
  const value = {
    rootPluginInstanceId,
    affectedPluginInstanceIds:[...new Set(affectedPluginInstanceIds)],
    code,
    message,
    action,
  };
  if (details !== undefined) value.details = structuredClone(details);
  return value;
}

function publicConnectionChallenge(challenge) {
  return {
    challengeId:challenge.challengeId,
    planId:challenge.planId,
    operationId:challenge.operationId,
    projectId:challenge.projectId,
    environmentId:challenge.environmentId,
    pluginInstanceId:challenge.pluginInstanceId,
    expectedRevision:challenge.expectedRevision,
    generation:challenge.generation,
    digest:challenge.digest,
    host:challenge.host,
    port:challenge.port,
    algorithm:challenge.algorithm,
    fingerprint:challenge.fingerprint,
    expiresAt:challenge.expiresAt,
  };
}

export class ConnectionIntentCoordinator {
  constructor(manager) {
    this.manager = manager;
    this.plans = new Map();
    this.operations = new Map();
    this.operationsById = new Map();
    this.requests = new Map();
    this.requestPlans = new Map();
    this.reservedPlanIds = new Set();
    this.legacyCancelFences = new Map();
    this.operationGenerations = new Map();
    this.connectionChallenges = new Map();
  }

  request(payload = {}) {
    const intent = payload.intent;
    if (!VALID_INTENTS.has(intent)) throw new AppError('CONNECTION_INTENT_INVALID','连接意图无效。');
    if (!payload.projectId || !payload.environmentId) throw new AppError('CONNECTION_SCOPE_INVALID','连接范围无效。');
    if (intent === 'cancel') return this.cancel(payload);
    if (intent === 'disconnect') return this.disconnect(payload);

    const requestId = payload.requestId ?? crypto.randomUUID();
    const requestKey = `${payload.projectId}/${payload.environmentId}/${requestId}`;
    const existing = this.requests.get(requestKey);
    if (existing) return existing;
    const planId = payload.planId ?? crypto.randomUUID();
    if (this.reservedPlanIds.has(planId) || this.plans.has(planId)) {
      throw new AppError('CONNECTION_PLAN_ID_CONFLICT','连接计划标识已经被使用。');
    }
    this.reservedPlanIds.add(planId);
    const promise = this.startConnectPlan({...payload,requestId,planId})
      .finally(() => this.reservedPlanIds.delete(planId));
    this.requests.set(requestKey,promise);
    this.requestPlans.set(requestKey,planId);
    return promise;
  }

  async buildConnectionPlan(payload) {
    this.manager.assertConfigurationStable(payload.projectId,payload.environmentId,{ownerId:payload.fenceOwnerId ?? null});
    const environment = await this.manager.workspaceStore.getEnvironment(payload.projectId,payload.environmentId);
    if (payload.expectedRevision !== undefined && payload.expectedRevision !== null && environment.revision !== payload.expectedRevision) {
      throw new AppError('CONFIG_REVISION_CONFLICT','环境配置已经变化，请刷新后重试。');
    }
    const plugins = this.manager.rememberPlugins(
      payload.projectId,
      payload.environmentId,
      await this.manager.workspaceStore.listPlugins(payload.projectId,payload.environmentId),
    );
    this.manager.assertConfigurationStable(payload.projectId,payload.environmentId,{ownerId:payload.fenceOwnerId ?? null});
    const byId = new Map(plugins.map((plugin) => [plugin.pluginInstanceId,plugin]));
    const requestedIds = Array.isArray(payload.pluginInstanceIds)
      ? [...new Set(payload.pluginInstanceIds.map((value) => String(value)))]
      : null;
    let selected = payload.pluginInstanceId
      ? [byId.get(payload.pluginInstanceId)].filter(Boolean)
      : requestedIds
        ? requestedIds.map((pluginInstanceId) => byId.get(pluginInstanceId)).filter(Boolean)
        : plugins;
    if (payload.pluginInstanceId && !selected.length) throw new AppError('PLUGIN_NOT_FOUND','插件不存在。');
    if (requestedIds && selected.length !== requestedIds.length) {
      throw new AppError('PLUGIN_NOT_FOUND','恢复连接集合中包含已经不存在的插件。');
    }
    if (payload.intent === 'retry' && !payload.pluginInstanceId) {
      const manualDisconnected = this.manager.state(payload.projectId,payload.environmentId).manualDisconnected ?? {};
      selected = selected.filter((plugin) => !manualDisconnected[plugin.pluginInstanceId]);
    }

    const actionGroups = new Map();
    const nodes = new Map();
    const addAction = (rootPluginInstanceId,affectedPluginInstanceId,code,message,action = 'configure') => {
      const existing = actionGroups.get(rootPluginInstanceId);
      if (existing) {
        if (!existing.affectedPluginInstanceIds.includes(affectedPluginInstanceId)) {
          existing.affectedPluginInstanceIds.push(affectedPluginInstanceId);
        }
        return;
      }
      actionGroups.set(rootPluginInstanceId,publicAction({
        rootPluginInstanceId,
        affectedPluginInstanceIds:[affectedPluginInstanceId],
        code,
        message,
        action,
      }));
    };
    const addNode = (plugin) => {
      if (!nodes.has(plugin.pluginInstanceId)) {
        nodes.set(plugin.pluginInstanceId,{
          plugin,
          pluginInstanceId:plugin.pluginInstanceId,
          dependencyId:plugin.transport?.kind === 'serverTunnel'
            ? plugin.transport.serverPluginInstanceId ?? null
            : null,
          connectionFingerprint:pluginConnectionFingerprint(plugin),
          requestedOperationId:payload.pluginInstanceId === plugin.pluginInstanceId ? payload.operationId ?? null : null,
          operationId:null,
          status:'pending',
        });
      }
    };

    for (const plugin of selected) {
      if (plugin.configState !== 'ready') {
        addAction(plugin.pluginInstanceId,plugin.pluginInstanceId,'PLUGIN_CONFIG_INCOMPLETE',`${plugin.displayName} 的配置尚未完成。`);
        continue;
      }
      if (plugin.transport?.kind !== 'serverTunnel') {
        addNode(plugin);
        continue;
      }
      const providerId = plugin.transport.serverPluginInstanceId;
      const provider = byId.get(providerId);
      const providerReady = provider?.pluginType === 'server'
        && provider.configState === 'ready'
        && provider.tunnelProvider !== false;
      if (!providerReady) {
        addAction(providerId ?? plugin.pluginInstanceId,plugin.pluginInstanceId,'TUNNEL_PROVIDER_UNAVAILABLE',`${plugin.displayName} 的 Server 隧道依赖不可用。`,'view-provider');
        if (provider) addAction(provider.pluginInstanceId,provider.pluginInstanceId,'PLUGIN_CONFIG_INCOMPLETE',`${provider.displayName} 的配置尚未完成。`);
        continue;
      }
      addNode(provider);
      addNode(plugin);
    }

    return {
      requestId:payload.requestId,
      planId:payload.planId,
      projectId:payload.projectId,
      environmentId:payload.environmentId,
      pluginInstanceId:payload.pluginInstanceId ?? null,
      intent:payload.intent,
      source:payload.source ?? 'unknown',
      actor:payload.actor ?? (payload.source === 'system' ? 'system' : 'user'),
      environment,
      plugins,
      byId,
      nodes,
      actionGroups,
      actions:[...actionGroups.values()],
      secretsByPlugin:payload.secretsByPlugin ?? {},
      retryableOnly:Boolean(payload.retryableOnly),
      cancelled:false,
      completed:false,
      startedOperations:0,
      cancelPromise:null,
      cancelResolve:null,
      resultPromise:null,
    };
  }

  initializePlanState(plan) {
    const previous = this.manager.state(plan.projectId,plan.environmentId);
    const state = structuredClone(previous);
    const plannedIds = new Set(plan.nodes.keys());
    state.intentGeneration += 1;
    state.connectAttemptId = plan.planId;
    state.desiredConnected = plannedIds.size > 0 || Object.values(state.plugins).some((item) => item.phase === 'connected');
    state.phase = plan.intent === 'retry' ? 'reconnecting' : 'connecting';
    state.networkEpoch = this.manager.networkEpoch;

    if (plan.pluginInstanceId && !previous.desiredConnected) {
      for (const plugin of plan.plugins) {
        if (plugin.configState !== 'ready' || plannedIds.has(plugin.pluginInstanceId)) continue;
        state.manualDisconnected[plugin.pluginInstanceId] = true;
        state.plugins[plugin.pluginInstanceId] = runtimePluginState(plugin,'disconnected',{reason:'USER_DISCONNECTED'});
      }
    }
    for (const id of plannedIds) delete state.manualDisconnected[id];
    for (const plugin of plan.plugins) {
      const current = state.plugins[plugin.pluginInstanceId];
      if (plugin.configState !== 'ready') {
        state.plugins[plugin.pluginInstanceId] = runtimePluginState(plugin,'disconnected',{reason:'PLUGIN_CONFIG_INCOMPLETE'});
      } else if (!current) {
        state.plugins[plugin.pluginInstanceId] = runtimePluginState(plugin);
      }
    }
    for (const action of plan.actions) {
      for (const affectedId of action.affectedPluginInstanceIds) {
        const plugin = plan.byId.get(affectedId);
        if (!plugin || plugin.configState !== 'ready') continue;
        state.plugins[affectedId] = runtimePluginState(plugin,'blocked',{
          reason:action.code === 'TUNNEL_PROVIDER_UNAVAILABLE' ? action.code : 'PLUGIN_CONFIG_INCOMPLETE',
          retryable:action.code === 'TUNNEL_PROVIDER_UNAVAILABLE',
        });
      }
    }
    this.manager.aggregate(state,plan.plugins);
    if (plannedIds.size && !Object.values(state.plugins).some((item) => item.phase === 'connected')) {
      state.phase = plan.intent === 'retry' ? 'reconnecting' : 'connecting';
    }
    this.manager.publish(state);
  }

  async startConnectPlan(payload) {
    const fenceKey = `${payload.projectId}/${payload.environmentId}`;
    const legacyFence = this.legacyCancelFences.get(fenceKey);
    if (legacyFence) await legacyFence.catch(() => undefined);
    const plan = await this.buildConnectionPlan(payload);
    this.invalidateConnectionChallenges(payload.projectId,payload.environmentId);
    this.plans.set(plan.planId,plan);
    plan.cancelPromise = new Promise((resolve) => { plan.cancelResolve = resolve; });
    this.initializePlanState(plan);

    payload.onPlanStarted?.(plan);
    const work = Promise.all([...plan.nodes.keys()].map((pluginInstanceId) => this.connectNode(plan,pluginInstanceId)))
      .catch(() => []);
    plan.workPromise = work;
    plan.resultPromise = (async () => {
      await Promise.race([work,plan.cancelPromise]);
      if (!plan.cancelled) {
        await work;
        plan.completed = true;
        this.publishAggregate(plan);
        await Promise.resolve(this.manager.workspaceStore.appendAudit?.(plan.projectId,{
          type:'connection-plan-completed',
          projectId:plan.projectId,
          environmentId:plan.environmentId,
          planId:plan.planId,
          actor:plan.actor,
          result:plan.actions.length ? 'needs-action' : 'completed',
        })).catch(() => undefined);
      }
      const result = this.result(plan,plan.cancelled
        ? 'cancelled'
        : plan.actions.length
          ? 'needs-action'
          : plan.startedOperations > 0 ? 'started' : 'already-satisfied');
      this.pruneHistory();
      return result;
    })();
    return plan.resultPromise;
  }

  publishAggregate(plan) {
    const state = structuredClone(this.manager.state(plan.projectId,plan.environmentId));
    this.manager.aggregate(state,plan.plugins);
    this.manager.publish(state);
  }

  result(plan,outcome,actions = plan.actions) {
    const targetOperationId = plan.pluginInstanceId
      ? plan.nodes.get(plan.pluginInstanceId)?.operationId ?? null
      : null;
    return {
      outcome,
      planId:plan.planId,
      operationId:targetOperationId,
      actions:structuredClone(actions),
      snapshot:this.manager.snapshot(plan.projectId,plan.environmentId),
    };
  }

  async connectNode(plan,pluginInstanceId) {
    const node = plan.nodes.get(pluginInstanceId);
    if (!node || plan.cancelled) return false;
    if (node.dependencyId) {
      const providerOk = await this.connectNode(plan,node.dependencyId);
      if (!providerOk) {
        if (!plan.cancelled) this.publishBlockedNode(plan,node);
        return false;
      }
    }
    if (plan.cancelled) return false;
    const state = this.manager.state(plan.projectId,plan.environmentId);
    if (state.plugins[pluginInstanceId]?.phase === 'connected') {
      node.status = 'satisfied';
      return true;
    }
    if (plan.retryableOnly) {
      const current = state.plugins[pluginInstanceId];
      if (current?.phase === 'error' && !current.retryable) return false;
    }
    const key = operationKey(plan.projectId,plan.environmentId,node.pluginInstanceId);
    const cancelling = this.operations.get(key);
    if (cancelling?.status === 'cancelling') {
      await cancelling.promise.catch(() => false);
      if (plan.cancelled) return false;
    }
    const operation = this.acquireOperation(plan,node);
    const connected = await operation.promise;
    if (!connected && !plan.cancelled) this.recordRuntimeAction(plan,node);
    return connected;
  }

  addPlanAction(plan,{rootPluginInstanceId,affectedPluginInstanceIds,code,message,action,details}) {
    const existing = plan.actionGroups.get(rootPluginInstanceId);
    if (existing) {
      for (const id of affectedPluginInstanceIds) {
        if (!existing.affectedPluginInstanceIds.includes(id)) existing.affectedPluginInstanceIds.push(id);
      }
      if (details?.hostKeyChallenge) {
        existing.code = code;
        existing.message = message;
        existing.action = action;
        existing.details = structuredClone(details);
      }
    } else {
      plan.actionGroups.set(rootPluginInstanceId,publicAction({
        rootPluginInstanceId,affectedPluginInstanceIds,code,message,action,details,
      }));
    }
    plan.actions = [...plan.actionGroups.values()];
  }

  recordRuntimeAction(plan,node) {
    const runtime = this.manager.state(plan.projectId,plan.environmentId).plugins[node.pluginInstanceId];
    const code = runtime?.reason ?? 'CONNECTION_FAILED';
    const credentialFailure = ['AUTHENTICATION_FAILED','SSH_AUTH_FAILED','CREDENTIAL_UNAVAILABLE','CREDENTIAL_BINDING_MISMATCH'].includes(code);
    const hostKeyChallenge = code === 'SSH_HOST_KEY_CONFIRM_REQUIRED'
      ? this.ensureHostKeyChallenge(plan,node,runtime)
      : null;
    this.addPlanAction(plan,{
      rootPluginInstanceId:node.pluginInstanceId,
      affectedPluginInstanceIds:[node.pluginInstanceId],
      code,
      message:runtime?.error?.message ?? `${node.plugin.displayName} 连接失败。`,
      action:code === 'SSH_HOST_KEY_CONFIRM_REQUIRED'
        ? 'confirm-host-key'
        : credentialFailure ? 'configure-credential' : 'retry',
      ...(hostKeyChallenge ? {details:{hostKeyChallenge}} : {}),
    });
  }

  ensureHostKeyChallenge(plan,node,runtime) {
    const operation = this.operationsById.get(node.operationId);
    const observed = runtime?.error?.details ?? {};
    if (!operation || operation.pluginInstanceId !== node.pluginInstanceId
      || node.plugin.pluginType !== 'server' || !observed.fingerprint) return null;
    const existing = [...this.connectionChallenges.values()].find((challenge) => (
      challenge.status === 'pending'
      && challenge.planId === plan.planId
      && challenge.operationId === operation.operationId
    ));
    if (existing) return publicConnectionChallenge(existing);
    const createdAt = Date.now();
    const challenge = {
      challengeId:crypto.randomUUID(),
      planId:plan.planId,
      operationId:operation.operationId,
      projectId:plan.projectId,
      environmentId:plan.environmentId,
      pluginInstanceId:node.pluginInstanceId,
      expectedRevision:node.plugin.revision,
      generation:operation.generation,
      digest:operation.digest,
      host:node.plugin.target?.host ?? null,
      port:Number(node.plugin.target?.port),
      algorithm:observed.algorithm ?? null,
      fingerprint:observed.fingerprint,
      createdAt,
      expiresAt:new Date(createdAt + CONNECTION_CHALLENGE_TTL_MS).toISOString(),
      status:'pending',
    };
    this.connectionChallenges.set(challenge.challengeId,challenge);
    this.pruneHistory();
    return publicConnectionChallenge(challenge);
  }

  publishBlockedNode(plan,node) {
    const state = structuredClone(this.manager.state(plan.projectId,plan.environmentId));
    state.plugins[node.pluginInstanceId] = runtimePluginState(node.plugin,'blocked',{
      reason:'TUNNEL_PROVIDER_UNAVAILABLE',retryable:true,
    });
    this.manager.aggregate(state,plan.plugins);
    this.manager.publish(state);
    const providerId = node.dependencyId ?? node.pluginInstanceId;
    this.addPlanAction(plan,{
      rootPluginInstanceId:providerId,
      affectedPluginInstanceIds:[providerId,node.pluginInstanceId],
      code:'TUNNEL_PROVIDER_UNAVAILABLE',
      message:`${node.plugin.displayName} 的 Server 隧道当前不可用。`,
      action:'retry-provider',
    });
  }

  acquireOperation(plan,node) {
    const key = operationKey(plan.projectId,plan.environmentId,node.pluginInstanceId);
    const existing = this.operations.get(key);
    if (existing && existing.status === 'running' && existing.connectionFingerprint === node.connectionFingerprint) {
      existing.subscribers.add(plan.planId);
      node.operationId = existing.operationId;
      node.status = 'subscribed';
      return existing;
    }
    if (existing && existing.status === 'running') {
      throw new AppError('CONNECTION_OPERATION_CONFLICT','插件配置变化后存在尚未结束的连接操作。');
    }
    const operationId = node.requestedOperationId ?? crypto.randomUUID();
    const operationCollision = this.operationsById.get(operationId);
    if (operationCollision && operationCollision.status === 'running') {
      throw new AppError('CONNECTION_OPERATION_ID_CONFLICT','连接操作标识已经被使用。');
    }
    const operation = {
      operationId,
      key,
      projectId:plan.projectId,
      environmentId:plan.environmentId,
      pluginInstanceId:node.pluginInstanceId,
      plugin:node.plugin,
      connectionFingerprint:node.connectionFingerprint,
      digest:node.connectionFingerprint,
      generation:(this.operationGenerations.get(key) ?? 0) + 1,
      planId:plan.planId,
      controller:new AbortController(),
      subscribers:new Set([plan.planId]),
      status:'running',
      promise:null,
    };
    node.operationId = operationId;
    node.status = 'running';
    plan.startedOperations += 1;
    this.operations.set(key,operation);
    this.operationGenerations.set(key,operation.generation);
    this.operationsById.set(operationId,operation);
    this.publishConnecting(operation);
    operation.promise = this.runOperation(plan,operation)
      .finally(() => {
        if (this.operations.get(key) === operation) this.operations.delete(key);
        this.pruneHistory();
      });
    return operation;
  }

  publishConnecting(operation) {
    const state = structuredClone(this.manager.state(operation.projectId,operation.environmentId));
    const current = state.plugins[operation.pluginInstanceId];
    state.plugins[operation.pluginInstanceId] = runtimePluginState(operation.plugin,'connecting',{
      attempt:(current?.attempt ?? 0) + 1,
      operationId:operation.operationId,
      planId:operation.planId,
      generation:operation.generation,
      digest:operation.digest,
    });
    state.desiredConnected = true;
    state.phase = 'connecting';
    this.manager.publish(state);
  }

  async runOperation(plan,operation) {
    let runtimeConnected = false;
    try {
      const result = await this.manager.withConnectPermit(
        () => this.manager.connectRuntime(
          operation.plugin,
          plan.secretsByPlugin[operation.pluginInstanceId] ?? {},
          {signal:operation.controller.signal},
        ),
        {signal:operation.controller.signal},
      );
      runtimeConnected = true;
      if (operation.controller.signal.aborted || this.operations.get(operation.key) !== operation) return false;
      const latest = await this.manager.workspaceStore.getPlugin(
        operation.projectId,
        operation.environmentId,
        operation.pluginInstanceId,
      );
      if (operation.controller.signal.aborted || this.operations.get(operation.key) !== operation) {
        await this.manager.disconnectRuntime(operation.plugin,'stale-connect-result');
        return false;
      }
      if (pluginConnectionFingerprint(latest) !== operation.connectionFingerprint) {
        await this.manager.disconnectRuntime(operation.plugin,'plugin-revision-changed');
        this.publishOperationError(operation,new AppError('MANUAL_RECONNECT_REQUIRED','插件配置已经变化，请重新连接。'));
        operation.status = 'failed';
        return false;
      }
      const state = structuredClone(this.manager.state(operation.projectId,operation.environmentId));
      if (this.operations.get(operation.key) !== operation) return false;
      state.plugins[operation.pluginInstanceId] = runtimePluginState(operation.plugin,'connected',{
        connectedAt:result.connectedAt,
        routeGeneration:result.routeGeneration ?? result.generation ?? 0,
        operationId:null,
        planId:null,
        generation:operation.generation,
        digest:operation.digest,
      });
      const plugins = this.manager.pluginCatalogs.get(this.manager.key(operation.projectId,operation.environmentId)) ?? [operation.plugin];
      this.manager.aggregate(state,plugins);
      this.manager.publish(state);
      operation.status = 'completed';
      return true;
    } catch (error) {
      if (runtimeConnected && this.operations.get(operation.key) === operation) {
        await this.manager.disconnectRuntime(operation.plugin,'connect-postcheck-failed').catch(() => undefined);
      }
      if (operation.controller.signal.aborted || error?.code === 'CONNECT_CANCELLED') {
        if (this.operations.get(operation.key) === operation) this.publishOperationCancelled(operation);
        operation.status = 'cancelled';
        return false;
      }
      if (this.operations.get(operation.key) === operation) this.publishOperationError(operation,error);
      operation.status = 'failed';
      return false;
    }
  }

  publishOperationCancelled(operation) {
    const state = structuredClone(this.manager.state(operation.projectId,operation.environmentId));
    state.plugins[operation.pluginInstanceId] = runtimePluginState(operation.plugin,'disconnected',{
      reason:'CONNECT_CANCELLED',operationId:null,planId:null,
      generation:operation.generation,digest:operation.digest,
    });
    const plugins = this.manager.pluginCatalogs.get(this.manager.key(operation.projectId,operation.environmentId)) ?? [operation.plugin];
    const activeInScope = [...this.operations.values()].some((candidate) => (
      candidate !== operation
      && candidate.projectId === operation.projectId
      && candidate.environmentId === operation.environmentId
      && candidate.status === 'running'
    ));
    if (!activeInScope && !Object.values(state.plugins).some((item) => item.phase === 'connected')) state.desiredConnected = false;
    this.manager.aggregate(state,plugins);
    this.manager.publish(state);
  }

  publishOperationError(operation,error) {
    const value = toPublicError(error);
    operation.error = value;
    const state = structuredClone(this.manager.state(operation.projectId,operation.environmentId));
    state.plugins[operation.pluginInstanceId] = runtimePluginState(operation.plugin,'error',{
      reason:value.code,
      retryable:!terminalConnectionError(error),
      error:value,
      operationId:null,
      planId:null,
      generation:operation.generation,
      digest:operation.digest,
    });
    const plugins = this.manager.pluginCatalogs.get(this.manager.key(operation.projectId,operation.environmentId)) ?? [operation.plugin];
    this.manager.aggregate(state,plugins);
    this.manager.publish(state);
  }

  staleConnectionChallenge() {
    return new AppError('CONNECTION_CHALLENGE_STALE','连接确认已经过期或不再属于当前配置，请重新连接。');
  }

  assertConnectionChallengePayload(challenge,payload,{allowCommitted = false} = {}) {
    const expiresAt = Date.parse(challenge?.expiresAt ?? '');
    if (!challenge || challenge.status !== 'pending' || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw this.staleConnectionChallenge();
    }
    if (payload?.decision !== 'trust-host-key'
      || payload.challengeId !== challenge.challengeId
      || payload.planId !== challenge.planId
      || payload.operationId !== challenge.operationId
      || Number(payload.expectedRevision) !== challenge.expectedRevision) {
      throw this.staleConnectionChallenge();
    }
    for (const field of [
      'projectId','environmentId','pluginInstanceId','generation','digest',
      'host','port','algorithm','fingerprint','expiresAt',
    ]) {
      if (payload[field] !== undefined && payload[field] !== challenge[field]) {
        throw this.staleConnectionChallenge();
      }
    }
    const operation = this.operationsById.get(challenge.operationId);
    const plan = this.plans.get(challenge.planId);
    if (!operation || !plan
      || operation.projectId !== challenge.projectId
      || operation.environmentId !== challenge.environmentId
      || operation.pluginInstanceId !== challenge.pluginInstanceId
      || operation.generation !== challenge.generation
      || operation.digest !== challenge.digest
      || (!allowCommitted && operation.status !== 'failed')
      || plan.projectId !== challenge.projectId
      || plan.environmentId !== challenge.environmentId) {
      throw this.staleConnectionChallenge();
    }
    return {operation,plan};
  }

  async validateConnectionChallenge(payload = {}) {
    const challenge = this.connectionChallenges.get(payload.challengeId);
    this.assertConnectionChallengePayload(challenge,payload);
    const plugin = await this.manager.workspaceStore.getPlugin(
      challenge.projectId,challenge.environmentId,challenge.pluginInstanceId,
    ).catch(() => null);
    if (!plugin || plugin.revision !== challenge.expectedRevision
      || plugin.pluginType !== 'server'
      || plugin.target?.host !== challenge.host
      || Number(plugin.target?.port) !== challenge.port
      || pluginConnectionFingerprint(plugin) !== challenge.digest) {
      challenge.status = 'stale';
      throw this.staleConnectionChallenge();
    }
    return publicConnectionChallenge(challenge);
  }

  async resumeConnectionChallenge(payload = {},{plugin} = {}) {
    const challenge = this.connectionChallenges.get(payload.challengeId);
    const {plan} = this.assertConnectionChallengePayload(challenge,payload,{allowCommitted:true});
    const committed = await this.manager.workspaceStore.getPlugin(
      challenge.projectId,challenge.environmentId,challenge.pluginInstanceId,
    ).catch(() => null);
    const trusted = plugin ?? committed;
    if (!committed || !trusted
      || committed.projectId !== challenge.projectId
      || committed.environmentId !== challenge.environmentId
      || committed.pluginInstanceId !== challenge.pluginInstanceId
      || trusted.projectId !== committed.projectId
      || trusted.environmentId !== committed.environmentId
      || trusted.pluginInstanceId !== committed.pluginInstanceId
      || committed.revision !== trusted.revision
      || committed.revision <= challenge.expectedRevision
      || committed.pluginType !== 'server'
      || committed.target?.host !== challenge.host
      || Number(committed.target?.port) !== challenge.port
      || committed.target?.hostKeyFingerprint !== challenge.fingerprint) {
      challenge.status = 'stale';
      throw this.staleConnectionChallenge();
    }

    const latestPlugins = await this.manager.workspaceStore.listPlugins(challenge.projectId,challenge.environmentId);
    const byId = new Map(latestPlugins.map((item) => [item.pluginInstanceId,item]));
    byId.set(trusted.pluginInstanceId,trusted);
    const affected = new Set([challenge.pluginInstanceId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of plan.nodes.values()) {
        if (node.dependencyId && affected.has(node.dependencyId) && !affected.has(node.pluginInstanceId)) {
          affected.add(node.pluginInstanceId);
          changed = true;
        }
      }
    }
    for (const pluginInstanceId of affected) {
      const node = plan.nodes.get(pluginInstanceId);
      const current = byId.get(pluginInstanceId);
      if (!node || !current || current.configState !== 'ready') continue;
      node.plugin = current;
      node.connectionFingerprint = pluginConnectionFingerprint(current);
      node.requestedOperationId = null;
      node.operationId = null;
      node.status = 'pending';
    }
    plan.plugins = latestPlugins.map((item) => byId.get(item.pluginInstanceId) ?? item);
    plan.byId = byId;
    plan.environment = await this.manager.workspaceStore.getEnvironment(challenge.projectId,challenge.environmentId);
    plan.secretsByPlugin = {};
    plan.cancelled = false;
    plan.completed = false;
    plan.startedOperations = 0;
    for (const [rootPluginInstanceId,action] of plan.actionGroups) {
      if (affected.has(rootPluginInstanceId)
        || action.details?.hostKeyChallenge?.challengeId === challenge.challengeId) {
        plan.actionGroups.delete(rootPluginInstanceId);
      }
    }
    plan.actions = [...plan.actionGroups.values()];
    plan.cancelPromise = new Promise((resolve) => { plan.cancelResolve = resolve; });
    challenge.status = 'consumed';
    for (const candidate of this.connectionChallenges.values()) {
      if (candidate !== challenge
        && candidate.projectId === challenge.projectId
        && candidate.environmentId === challenge.environmentId
        && candidate.pluginInstanceId === challenge.pluginInstanceId) candidate.status = 'stale';
    }

    this.manager.rememberPlugins(plan.projectId,plan.environmentId,plan.plugins);
    this.initializePlanState(plan);
    const roots = [...affected].filter((pluginInstanceId) => plan.nodes.has(pluginInstanceId));
    const work = Promise.all(roots.map((pluginInstanceId) => this.connectNode(plan,pluginInstanceId))).catch(() => []);
    plan.workPromise = work;
    plan.resultPromise = (async () => {
      await Promise.race([work,plan.cancelPromise]);
      if (!plan.cancelled) {
        await work;
        plan.completed = true;
        this.publishAggregate(plan);
        await Promise.resolve(this.manager.workspaceStore.appendAudit?.(plan.projectId,{
          type:'connection-plan-resumed',
          projectId:plan.projectId,
          environmentId:plan.environmentId,
          pluginInstanceId:challenge.pluginInstanceId,
          planId:plan.planId,
          operationId:challenge.operationId,
          actor:plan.actor,
          result:plan.actions.length ? 'needs-action' : 'completed',
        })).catch(() => undefined);
      }
      const result = this.result(plan,plan.cancelled
        ? 'cancelled'
        : plan.actions.length
          ? 'needs-action'
          : plan.startedOperations > 0 ? 'started' : 'already-satisfied');
      this.pruneHistory();
      return result;
    })();
    return plan.resultPromise;
  }

  invalidateConnectionChallenges(projectId,environmentId = null) {
    for (const challenge of this.connectionChallenges.values()) {
      if (challenge.projectId === projectId
        && (environmentId === null || challenge.environmentId === environmentId)
        && challenge.status === 'pending') challenge.status = 'stale';
    }
  }

  cancel(payload) {
    const matchedPlans = [];
    if (payload.force && payload.operationId) {
      const operation = this.operationsById.get(payload.operationId);
      if (this.isActiveOperationInScope(operation,payload)) {
        for (const planId of operation.subscribers) {
          const plan = this.plans.get(planId);
          if (plan && !plan.completed && !plan.cancelled) matchedPlans.push(plan);
        }
        this.forceCancelOperation(operation);
      }
    } else if (payload.planId) {
      const plan = this.plans.get(payload.planId);
      if (this.isActivePlanInScope(plan,payload)
        && (!payload.operationId || plan.nodes.get(payload.pluginInstanceId ?? '')?.operationId === payload.operationId
          || [...plan.nodes.values()].some((node) => node.operationId === payload.operationId))) {
        matchedPlans.push(plan);
        this.cancelPlan(plan,payload.operationId ?? null);
      }
    } else if (payload.legacyScope) {
      for (const plan of this.plans.values()) {
        if (this.isActivePlanInScope(plan,payload)) {
          matchedPlans.push(plan);
          this.cancelPlan(plan,null);
        }
      }
      if (matchedPlans.length) {
        const cancelledAttemptId = matchedPlans[0].planId;
        const cleanup = this.manager.ensureCancelledCleanup(payload.projectId,payload.environmentId,cancelledAttemptId);
        const fenceKey = `${payload.projectId}/${payload.environmentId}`;
        const fence = (cleanup.queueComplete ?? cleanup).catch(() => undefined).finally(() => {
          if (this.legacyCancelFences.get(fenceKey) === fence) this.legacyCancelFences.delete(fenceKey);
        });
        this.legacyCancelFences.set(fenceKey,fence);
      }
    }
    if (!matchedPlans.length) {
      return {
        outcome:'blocked',
        planId:payload.planId ?? null,
        operationId:payload.operationId ?? null,
        actions:[publicAction({
          rootPluginInstanceId:payload.pluginInstanceId ?? null,
          affectedPluginInstanceIds:payload.pluginInstanceId ? [payload.pluginInstanceId] : [],
          code:'CONNECTION_OPERATION_NOT_OWNED',
          message:'连接操作已经结束或不属于当前计划。',
          action:'refresh',
        })],
        snapshot:this.manager.snapshot(payload.projectId,payload.environmentId),
      };
    }
    this.publishCancellationState(payload.projectId,payload.environmentId);
    return {
      outcome:'cancelled',
      planId:payload.planId ?? matchedPlans[0]?.planId ?? null,
      operationId:payload.operationId ?? null,
      actions:[],
      snapshot:this.manager.snapshot(payload.projectId,payload.environmentId),
    };
  }

  isActivePlanInScope(plan,payload) {
    return Boolean(plan
      && !plan.cancelled
      && !plan.completed
      && plan.projectId === payload.projectId
      && plan.environmentId === payload.environmentId);
  }

  isActiveOperationInScope(operation,payload) {
    return Boolean(operation
      && operation.status === 'running'
      && operation.projectId === payload.projectId
      && operation.environmentId === payload.environmentId);
  }

  cancelPlan(plan,operationId = null) {
    if (!operationId) {
      plan.cancelled = true;
      plan.cancelResolve?.();
    }
    for (const node of plan.nodes.values()) {
      if (!node.operationId || (operationId && node.operationId !== operationId)) continue;
      const operation = this.operationsById.get(node.operationId);
      if (!this.isActiveOperationInScope(operation,plan)) continue;
      operation.subscribers.delete(plan.planId);
      if (!operation.subscribers.size) {
        operation.status = 'cancelling';
        operation.controller.abort(new AppError('CONNECT_CANCELLED','连接已取消。'));
      }
    }
    if (operationId) {
      const unfinished = [...plan.nodes.values()].some((node) => node.operationId !== operationId && node.status === 'running');
      if (!unfinished) {
        plan.cancelled = true;
        plan.cancelResolve?.();
      }
    }
  }

  forceCancelOperation(operation) {
    for (const planId of operation.subscribers) {
      const plan = this.plans.get(planId);
      if (!plan || plan.completed || plan.cancelled) continue;
      plan.cancelled = true;
      plan.cancelResolve?.();
    }
    operation.subscribers.clear();
    operation.status = 'cancelling';
    operation.controller.abort(new AppError('CONNECT_CANCELLED','连接已强制取消。'));
  }

  publishCancellationState(projectId,environmentId) {
    const state = structuredClone(this.manager.state(projectId,environmentId));
    let hasActive = false;
    for (const operation of this.operations.values()) {
      if (operation.projectId !== projectId || operation.environmentId !== environmentId
        || !['running','cancelling'].includes(operation.status)) continue;
      if (operation.status === 'running' && operation.subscribers.size) {
        hasActive = true;
        continue;
      }
      const current = state.plugins[operation.pluginInstanceId];
      if (current?.phase === 'connecting') {
        state.plugins[operation.pluginInstanceId] = {...current,phase:'disconnecting',reason:'CONNECT_CANCELLED'};
      }
    }
    const hasConnected = Object.values(state.plugins).some((item) => item.phase === 'connected');
    state.desiredConnected = hasActive || hasConnected;
    if (!hasActive && !hasConnected) state.phase = 'disconnecting';
    this.manager.publish(state);
  }

  async disconnect(payload) {
    this.abortScope(payload.projectId,payload.environmentId,{pluginInstanceId:payload.pluginInstanceId,force:true});
    const snapshot = payload.pluginInstanceId
      ? await this.manager.disconnectPluginLegacy(payload.projectId,payload.environmentId,payload.pluginInstanceId)
      : await this.manager.disconnectLegacy(payload.projectId,payload.environmentId,payload.reason ?? 'user');
    return {
      outcome:'started',
      planId:payload.planId ?? null,
      operationId:payload.operationId ?? null,
      actions:[],
      snapshot,
    };
  }

  abortScope(projectId,environmentId,{pluginInstanceId = null,force = false} = {}) {
    const affected = new Set(pluginInstanceId ? [pluginInstanceId] : []);
    if (pluginInstanceId) {
      const plugins = this.manager.pluginCatalogs.get(this.manager.key(projectId,environmentId)) ?? [];
      const target = plugins.find((plugin) => plugin.pluginInstanceId === pluginInstanceId);
      if (target?.pluginType === 'server') {
        for (const plugin of plugins) {
          if (plugin.transport?.serverPluginInstanceId === pluginInstanceId) affected.add(plugin.pluginInstanceId);
        }
      }
    }
    for (const operation of this.operations.values()) {
      if (operation.projectId !== projectId || operation.environmentId !== environmentId || operation.status !== 'running') continue;
      if (affected.size && !affected.has(operation.pluginInstanceId)) continue;
      if (force) this.forceCancelOperation(operation);
      else if (!operation.subscribers.size) operation.controller.abort(new AppError('CONNECT_CANCELLED','连接已取消。'));
    }
  }

  pruneHistory() {
    const removeOldest = (map,canRemove,limit = HISTORY_LIMIT) => {
      while (map.size > limit) {
        const removable = [...map.entries()].find(([key,value]) => canRemove(value,key));
        if (!removable) break;
        map.delete(removable[0]);
      }
    };
    removeOldest(this.operationsById,(operation) => !['running','cancelling'].includes(operation.status));
    removeOldest(this.plans,(plan) => plan.completed || plan.cancelled);
    removeOldest(this.requests,(_promise,requestKey) => {
      const plan = this.plans.get(this.requestPlans.get(requestKey));
      return !plan || plan.completed || plan.cancelled;
    });
    for (const requestKey of this.requestPlans.keys()) {
      if (!this.requests.has(requestKey)) this.requestPlans.delete(requestKey);
    }
    const now = Date.now();
    for (const [challengeId,challenge] of this.connectionChallenges) {
      if (challenge.status !== 'pending' || Date.parse(challenge.expiresAt) <= now) {
        this.connectionChallenges.delete(challengeId);
      }
    }
    removeOldest(this.connectionChallenges,() => true,CONNECTION_CHALLENGE_LIMIT);
  }

  forgetProject(projectId) {
    this.invalidateConnectionChallenges(projectId);
    for (const operation of this.operations.values()) {
      if (operation.projectId === projectId) this.forceCancelOperation(operation);
    }
    for (const [planId,plan] of this.plans) if (plan.projectId === projectId) this.plans.delete(planId);
    for (const [operationId,operation] of this.operationsById) {
      if (operation.projectId === projectId) this.operationsById.delete(operationId);
    }
    for (const key of this.requests.keys()) if (key.startsWith(`${projectId}/`)) this.requests.delete(key);
    for (const key of this.requestPlans.keys()) if (key.startsWith(`${projectId}/`)) this.requestPlans.delete(key);
    for (const key of this.legacyCancelFences.keys()) if (key.startsWith(`${projectId}/`)) this.legacyCancelFences.delete(key);
    for (const key of this.operationGenerations.keys()) if (key.startsWith(`${projectId}/`)) this.operationGenerations.delete(key);
    for (const [challengeId,challenge] of this.connectionChallenges) {
      if (challenge.projectId === projectId) this.connectionChallenges.delete(challengeId);
    }
  }

  forgetEnvironment(projectId,environmentId) {
    this.invalidateConnectionChallenges(projectId,environmentId);
    this.abortScope(projectId,environmentId,{force:true});
    for (const [planId,plan] of this.plans) {
      if (plan.projectId === projectId && plan.environmentId === environmentId) this.plans.delete(planId);
    }
    const prefix = `${projectId}/${environmentId}/`;
    for (const key of this.requests.keys()) if (key.startsWith(prefix)) this.requests.delete(key);
    for (const key of this.requestPlans.keys()) if (key.startsWith(prefix)) this.requestPlans.delete(key);
    for (const [operationId,operation] of this.operationsById) {
      if (operation.projectId === projectId && operation.environmentId === environmentId) this.operationsById.delete(operationId);
    }
    for (const key of this.operationGenerations.keys()) if (key.startsWith(prefix)) this.operationGenerations.delete(key);
    this.legacyCancelFences.delete(`${projectId}/${environmentId}`);
    for (const [challengeId,challenge] of this.connectionChallenges) {
      if (challenge.projectId === projectId && challenge.environmentId === environmentId) {
        this.connectionChallenges.delete(challengeId);
      }
    }
  }
}

export const connectionIntentInternals = {
  operationKey,
  publicAction,
  publicConnectionChallenge,
  runtimePluginState,
};
