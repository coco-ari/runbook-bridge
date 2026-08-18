const LEGACY_PHASES = {
  disconnected:{kind:'disconnected',label:'未连接',action:'connect',stateClass:'disconnected'},
  connecting:{kind:'connecting',label:'连接中',action:'cancel',stateClass:'connecting'},
  connected:{kind:'connected',label:'已连接',action:'disconnect',stateClass:'connected'},
  disconnecting:{kind:'disconnecting',label:'断开中',action:null,stateClass:'disconnecting'},
  reconnecting:{kind:'reconnecting',label:'正在重连',action:'cancel',stateClass:'reconnecting'},
  waitingDependency:{kind:'connecting',label:'等待隧道',action:'cancel',stateClass:'waitingDependency'},
  blocked:{kind:'dependency-blocked',label:'依赖不可用',action:'view-provider',stateClass:'blocked'},
  failed:{kind:'connection-error',label:'连接失败',action:'retry',stateClass:'error'},
  error:{kind:'connection-error',label:'连接失败',action:'retry',stateClass:'error'},
};

const STATUS_CLASSES = {
  'persistence-blocked':'error',
  'credential-recovery':'error',
  'needs-configuration':'draft',
  'dependency-blocked':'blocked',
  draft:'draft',
  preparing:'connecting',
  editing:'connecting',
  saving:'connecting',
  restoring:'reconnecting',
  connecting:'connecting',
  reconnecting:'reconnecting',
  disconnecting:'disconnecting',
  'connection-error':'error',
  connected:'connected',
  disconnected:'disconnected',
};

function assessmentFrom(value) {
  if (value?.primaryStatus && value?.configuration) return value;
  if (value?.assessment?.primaryStatus && value.assessment?.configuration) return value.assessment;
  return null;
}

export function pluginConnectionViewModel(plugin = {},runtimeEntry = {}) {
  const assessment = assessmentFrom(runtimeEntry) ?? assessmentFrom(plugin);
  if (assessment) {
    const primary = assessment.primaryStatus;
    const phase = assessment.runtime?.phase ?? assessment.phase ?? runtimeEntry.phase ?? 'disconnected';
    return {
      kind:primary.kind,
      label:primary.label,
      action:primary.action,
      stateClass:STATUS_CLASSES[primary.kind] ?? LEGACY_PHASES[phase]?.stateClass ?? 'disconnected',
      phase,
      configurationState:assessment.configuration.state,
      usesAssessment:true,
    };
  }

  const phase = runtimeEntry?.phase ?? 'disconnected';
  if (plugin.configState !== 'ready') {
    return {
      kind:'needs-configuration',label:'待配置',action:'continue-configuration',stateClass:'draft',
      phase,configurationState:'incomplete',usesAssessment:false,
    };
  }
  const legacy = LEGACY_PHASES[phase] ?? LEGACY_PHASES.disconnected;
  return {...legacy,phase,configurationState:'complete',usesAssessment:false};
}
