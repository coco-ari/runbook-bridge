import crypto from 'node:crypto';
import { CLOUD_PROJECT_VERSIONS, cloudTrashAvailable, cloudProjectDiff, snapshotDigest } from './cloud-config-snapshot.mjs';

export function projectSummary(project) {
  return {projectId:project.projectId,name:project.name,environmentCount:project.environments.length,
    pluginCount:project.environments.reduce((sum,env) => sum+env.plugins.length,0)};
}

// History stays inside the authenticated ciphertext, including deleted projects.
export function pruneCloudHistory(payload, now = Date.now()) {
  return {...payload,history:payload.history.filter(record => record.deletedAt === null || cloudTrashAvailable(record,now))};
}

export function appendCloudVersion(payload,project,{versionId = crypto.randomUUID(),createdAt = new Date().toISOString(),force = false} = {}) {
  const previous = payload.history.find(record => record.projectId === project.projectId);
  const same = previous?.deletedAt === null && snapshotDigest(previous.versions.at(-1).project) === snapshotDigest(project);
  const versions = same && !force ? previous.versions : [...(previous?.versions ?? []),{versionId,createdAt,project}].slice(-CLOUD_PROJECT_VERSIONS);
  const record = {projectId:project.projectId,deletedAt:null,versions};
  const index = payload.projects.findIndex(p => p.projectId === project.projectId);
  const projects = [...payload.projects];
  if (index === -1) projects.push(project); else projects[index] = project;
  return {...payload,projects,history:[...payload.history.filter(r => r.projectId !== project.projectId),record]};
}

export function cloudVersionSummaries(record) {
  return record.versions.map((version,index) => ({...projectSummary(version.project),versionId:version.versionId,
    createdAt:version.createdAt,hash:snapshotDigest(version.project),current:record.deletedAt === null && index === record.versions.length-1,
    diff:cloudProjectDiff(record.versions[index-1]?.project,version.project)})).reverse();
}
