import { pluginConnectionFingerprint } from './plugin-change-classifier.mjs';

export function hostKeyDraftBinding(plugin) {
  const {hostKeyFingerprint: _fingerprint, ...target} = plugin.target ?? {};
  return pluginConnectionFingerprint({...plugin,target});
}

export function applyHostKeyTrust(candidate, input, trust) {
  if (candidate.pluginType !== 'server' || !trust?.fingerprint
    || input.target?.hostKeyFingerprint !== trust.fingerprint
    || hostKeyDraftBinding(candidate) !== trust.binding) return candidate;
  return {...candidate,target:{...candidate.target,hostKeyFingerprint:trust.fingerprint}};
}
