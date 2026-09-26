import crypto from 'node:crypto';
import { cloudError } from './cloud-config-crypto.mjs';
import { CLOUD_PROJECT_VERSIONS, cloudTrashAvailable, cloudProjectDiff, snapshotDigest } from './cloud-config-snapshot.mjs';

export function projectSummary(project) {
  return {projectId:project.projectId,name:project.name,environmentCount:project.environments.length,
    pluginCount:project.environments.reduce((sum,env) => sum+env.plugins.length,0)};
}

// History stays inside the authenticated ciphertext, including deleted projects.
export function pruneCloudHistory(payload, now = Date.now()) {
  const tombstones = new Map((payload.tombstones ?? []).map(record => [record.projectId,record]));
  for (const {projectId,deletedAt} of payload.history) if (deletedAt !== null) tombstones.set(projectId,{projectId,deletedAt});
  return {...payload,schemaVersion:3,tombstones:[...tombstones.values()],history:payload.history.filter(record => record.deletedAt === null || cloudTrashAvailable(record,now))};
}

export function appendCloudVersion(payload,project,{versionId = crypto.randomUUID(),createdAt = new Date().toISOString(),force = false,restore = false} = {}) {
  const previous = payload.history.find(record => record.projectId === project.projectId);
  const deleted = previous?.deletedAt != null || payload.tombstones?.some(record => record.projectId === project.projectId);
  if (deleted && !restore) throw cloudError('PROJECT_DELETED','此项目已从云仓库删除，请先在云配置的回收站中恢复。超过恢复期限时，请创建新项目后上传。');
  const same = previous?.deletedAt === null && snapshotDigest(previous.versions.at(-1).project) === snapshotDigest(project);
  const versions = same && !force ? previous.versions : [...(previous?.versions ?? []),{versionId,createdAt,project}].slice(-CLOUD_PROJECT_VERSIONS);
  const record = {projectId:project.projectId,deletedAt:null,versions};
  const index = payload.projects.findIndex(p => p.projectId === project.projectId);
  const projects = [...payload.projects];
  if (index === -1) projects.push(project); else projects[index] = project;
  return {...payload,projects,history:[...payload.history.filter(r => r.projectId !== project.projectId),record],
    ...(payload.schemaVersion === 3 ? {tombstones:(payload.tombstones ?? []).filter(r => r.projectId !== project.projectId)} : {})};
}

export function cloudVersionSummaries(record) {
  return record.versions.map((version,index) => ({...projectSummary(version.project),versionId:version.versionId,
    createdAt:version.createdAt,hash:snapshotDigest(version.project),current:record.deletedAt === null && index === record.versions.length-1,
    diff:cloudProjectDiff(record.versions[index-1]?.project,version.project)})).reverse();
}
