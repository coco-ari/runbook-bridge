const MESSAGES = {
  UPDATE_ACCESS_DENIED:'软件更新只能由当前桌面主窗口操作。',
  UPDATE_INVALID_ARGUMENT:'软件更新请求参数无效。',
  UPDATE_UNAVAILABLE:'软件更新服务尚未就绪。',
  UPDATE_UNSUPPORTED:'当前运行方式或系统不支持在线安装更新，请使用正式安装版。',
  UPDATE_NO_SOURCE:'请先关联一个云仓库，再检查软件更新。',
  UPDATE_SOURCE_REQUIRED:'请先选择用于软件更新的云仓库。',
  UPDATE_SOURCE_INVALID:'软件更新来源无效，请重新关联云仓库。',
  UPDATE_HTTPS_REQUIRED:'在线升级要求云仓库使用 HTTPS，请先为云服务启用 HTTPS。',
  UPDATE_MANIFEST_INVALID:'云端版本信息无效，请联系云仓库管理员检查发布文件。',
  UPDATE_CHECK_FAILED:'无法检查软件更新，请检查网络及云端更新服务后重试。',
  UPDATE_DOWNLOAD_FAILED:'更新下载失败，请检查网络后重新检测和下载。',
  UPDATE_INTEGRITY_FAILED:'更新文件校验失败，已停止安装，请联系云仓库管理员重新发布。',
  UPDATE_NOT_AVAILABLE:'请先检查并找到新版本，再下载更新。',
  UPDATE_NOT_DOWNLOADED:'请先完成更新下载，再重启安装。',
  UPDATE_BUSY:'当前仍有未完成的操作或未保存内容，请处理后再重启更新。',
  UPDATE_INSTALL_FAILED:'暂时无法安装更新，请稍后重试。',
  UPDATE_CANCELLED:'本次软件更新操作已取消。',
  UPDATE_STATE_FAILED:'无法保存软件更新来源，请检查本机配置存储后重试。',
};
const ACTIONS = {status:[],check:[],download:[],cancel:[],install:[],source:['repositoryId']};

export function softwareUpdateError(code) {
  const safeCode = Object.hasOwn(MESSAGES,code) ? code : 'UPDATE_UNAVAILABLE';
  return Object.assign(new Error(MESSAGES[safeCode]),{code:safeCode});
}

export function publicSoftwareUpdateError(error,fallback = 'UPDATE_UNAVAILABLE') {
  const code = Object.hasOwn(MESSAGES,error?.code) ? error.code : fallback;
  return {code,message:MESSAGES[code]};
}

export function validateSoftwareUpdateRequest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || typeof payload.action !== 'string' || !Object.hasOwn(ACTIONS,payload.action)
    || Object.keys(payload).some(key => key !== 'action' && !ACTIONS[payload.action].includes(key))
    || (payload.action === 'source' && !(payload.repositoryId === null || validId(payload.repositoryId)))) {
    throw softwareUpdateError('UPDATE_INVALID_ARGUMENT');
  }
  return payload;
}

function validId(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value); }
function text(value,limit) {
  if (typeof value !== 'string') return '';
  let result = '', length = 0;
  for (const character of value.replace(/<[^>]*>/g,'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'')) {
    const bytes = Buffer.byteLength(character,'utf8');
    if (length + bytes > limit) break;
    result += character;
    length += bytes;
  }
  return result;
}
function origin(value) {
  try {
    const parsed = new URL(value);
    if (!['https:','http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') return '';
    return parsed.origin;
  } catch { return ''; }
}
function normalizedSources(value) {
  if (!Array.isArray(value)) throw softwareUpdateError('UPDATE_SOURCE_INVALID');
  const seen = new Set();
  return value.slice(0,20).filter(item => {
    if (!item || !validId(item.repositoryId) || seen.has(item.repositoryId)) return false;
    seen.add(item.repositoryId);
    return true;
  }).map(item => ({repositoryId:item.repositoryId,name:text(item.name,320) || '云仓库',origin:origin(item.origin)}));
}
function versionParts(value) {
  if (typeof value !== 'string' || value.length > 128 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)) return null;
  return value.split('+')[0].split('.').map(BigInt);
}
function newerVersion(candidate,current) {
  const a = versionParts(candidate), b = versionParts(current);
  if (!a || !b) throw softwareUpdateError('UPDATE_MANIFEST_INVALID');
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
}
function releaseDate(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}
function progress(value) {
  const finite = number => typeof number === 'number' && Number.isFinite(number) && number >= 0;
  if (!value || !finite(value.percent) || !finite(value.transferred) || !finite(value.total)) return null;
  return {percent:Math.min(100,value.percent),transferred:Math.min(Number.MAX_SAFE_INTEGER,value.transferred),total:Math.min(Number.MAX_SAFE_INTEGER,value.total)};
}
function stopDriver(driver) {
  for (const method of ['cancel','dispose']) {
    try { Promise.resolve(driver?.[method]?.()).catch(() => undefined); } catch {}
  }
}

export class SoftwareUpdateService {
  constructor({currentVersion,platform = process.platform,arch = process.arch,supported = true,getSources,createUpdater,install,loadSelection = async () => null,saveSelection = async () => {},now = () => new Date()}) {
    Object.assign(this,{platform,arch,getSources,createUpdater,installUpdate:install,loadSelection,saveSelection,now});
    this.supported = Boolean(supported && ['win32','darwin'].includes(platform) && ['x64','arm64'].includes(arch));
    this.state = {phase:'idle',currentVersion,availableVersion:null,releaseNotes:'',releaseDate:null,progress:null,error:null,checkedAt:null,source:null,sources:[],supported:this.supported};
    this.selectedId = null;
    this.generation = 0;
    this.driver = null;
    this.checkFlight = null;
    this.downloadFlight = null;
    this.selectionQueue = Promise.resolve();
    this.selectionPending = 0;
    this.sourceRefresh = 0;
    this.disposed = false;
  }

  async init() {
    this.initPromise ??= (async () => {
      try {
        const selected = await this.loadSelection();
        this.selectedId = validId(selected) ? selected : null;
      } catch { throw softwareUpdateError('UPDATE_STATE_FAILED'); }
    })();
    await this.initPromise;
    await this.refreshSources();
    return this.snapshot();
  }

  snapshot() { return structuredClone(this.state); }

  async invoke(action,input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.hasOwn(input,'action')) throw softwareUpdateError('UPDATE_INVALID_ARGUMENT');
    validateSoftwareUpdateRequest({action,...input});
    if (this.disposed) throw softwareUpdateError('UPDATE_UNAVAILABLE');
    await this.init();
    if (this.disposed) throw softwareUpdateError('UPDATE_UNAVAILABLE');
    if (action === 'status') return this.snapshot();
    if (action === 'source') return this.selectSource(input.repositoryId);
    if (action === 'cancel') {
      if (this.state.phase === 'installing') throw softwareUpdateError('UPDATE_BUSY');
      this.invalidate();
      return this.snapshot();
    }
    this.assertSource();
    return this[action]();
  }

  async refreshSources() {
    const refresh = ++this.sourceRefresh;
    let sources;
    try { sources = normalizedSources(await this.getSources()); }
    catch (error) {
      if (refresh !== this.sourceRefresh || this.disposed) return;
      this.invalidate();
      this.state.sources = [];
      this.state.source = null;
      this.state.phase = 'error';
      this.state.error = publicSoftwareUpdateError(error,'UPDATE_SOURCE_INVALID');
      throw softwareUpdateError(this.state.error.code);
    }
    if (refresh !== this.sourceRefresh || this.disposed) return;
    const source = this.selectedId ? sources.find(item => item.repositoryId === this.selectedId) ?? null : sources.length === 1 ? sources[0] : null;
    const previous = this.state.source;
    this.state.sources = sources;
    this.state.source = source;
    if (previous?.repositoryId !== source?.repositoryId || previous?.origin !== source?.origin) this.invalidate();
    else if (['idle','unsupported','no-source','source-required'].includes(this.state.phase)) this.state.phase = this.basePhase();
  }

  basePhase() {
    if (!this.supported) return 'unsupported';
    if (!this.state.sources.length) return 'no-source';
    if (!this.state.source) return 'source-required';
    return 'idle';
  }

  invalidate() {
    this.generation++;
    const driver = this.driver;
    this.driver = null;
    this.checkFlight = null;
    this.downloadFlight = null;
    Object.assign(this.state,{phase:this.basePhase(),availableVersion:null,releaseNotes:'',releaseDate:null,progress:null,error:null,checkedAt:null});
    stopDriver(driver);
  }

  async selectSource(repositoryId) {
    this.selectionPending++;
    const select = async () => {
      await this.refreshSources();
      if (this.state.phase === 'installing') throw softwareUpdateError('UPDATE_BUSY');
      if (repositoryId !== null && !this.state.sources.some(item => item.repositoryId === repositoryId)) throw softwareUpdateError('UPDATE_SOURCE_INVALID');
      this.invalidate();
      try { await this.saveSelection(repositoryId); }
      catch { throw softwareUpdateError('UPDATE_STATE_FAILED'); }
      this.selectedId = repositoryId;
      await this.refreshSources();
      return this.snapshot();
    };
    const task = this.selectionQueue.catch(() => undefined).then(select).finally(() => { this.selectionPending--; });
    this.selectionQueue = task;
    return task;
  }

  assertSource() {
    let code;
    if (this.selectionPending) code = 'UPDATE_BUSY';
    else if (!this.supported) code = 'UPDATE_UNSUPPORTED';
    else if (!this.state.sources.length) code = 'UPDATE_NO_SOURCE';
    else if (!this.state.source) code = 'UPDATE_SOURCE_REQUIRED';
    else if (!this.state.source.origin) code = 'UPDATE_SOURCE_INVALID';
    else if (!this.state.source.origin.startsWith('https://')) code = 'UPDATE_HTTPS_REQUIRED';
    if (code) {
      if (['UPDATE_HTTPS_REQUIRED','UPDATE_SOURCE_INVALID'].includes(code)) {
        this.state.phase = 'error';
        this.state.error = publicSoftwareUpdateError(softwareUpdateError(code));
      }
      throw softwareUpdateError(code);
    }
  }

  assertCurrent(generation,driver) {
    if (this.disposed || this.generation !== generation || (driver && this.driver !== driver)) throw softwareUpdateError('UPDATE_CANCELLED');
  }

  async check() {
    if (this.checkFlight) return this.checkFlight.promise;
    if (['downloading','downloaded','installing'].includes(this.state.phase)) return this.snapshot();
    this.invalidate();
    this.state.phase = 'checking';
    const generation = this.generation;
    const url = `${this.state.source.origin}/updates/${this.platform}/${this.arch}/`;
    const promise = Promise.resolve().then(async () => {
      let driver;
      try {
        driver = await this.createUpdater({url});
        if (generation !== this.generation || this.disposed) { stopDriver(driver); throw softwareUpdateError('UPDATE_CANCELLED'); }
        this.driver = driver;
        const result = await driver.check();
        this.assertCurrent(generation,driver);
        const available = result !== null && result !== undefined && newerVersion(result.version,this.state.currentVersion);
        this.state.checkedAt = new Date(this.now()).toISOString();
        if (!available) {
          this.state.phase = 'current';
          this.driver = null;
          stopDriver(driver);
        } else {
          Object.assign(this.state,{phase:'available',availableVersion:result.version,releaseNotes:text(result.releaseNotes,4096),releaseDate:releaseDate(result.releaseDate),error:null});
        }
        return this.snapshot();
      } catch (error) {
        this.assertCurrent(generation);
        this.state.phase = 'error';
        this.state.error = publicSoftwareUpdateError(error,'UPDATE_CHECK_FAILED');
        this.driver = null;
        stopDriver(driver);
        throw softwareUpdateError(this.state.error.code);
      } finally {
        if (this.checkFlight?.generation === generation) this.checkFlight = null;
      }
    });
    this.checkFlight = {generation,promise};
    return promise;
  }

  async download() {
    if (this.downloadFlight) return this.downloadFlight.promise;
    if (this.state.phase === 'downloaded') return this.snapshot();
    if (this.state.phase !== 'available' || !this.driver) throw softwareUpdateError('UPDATE_NOT_AVAILABLE');
    const driver = this.driver, generation = this.generation;
    Object.assign(this.state,{phase:'downloading',progress:{percent:0,transferred:0,total:0},error:null});
    const promise = Promise.resolve().then(async () => {
      try {
        await driver.download(value => {
          if (this.generation !== generation || this.driver !== driver || this.state.phase !== 'downloading') return;
          const next = progress(value);
          if (next) this.state.progress = next;
        });
        this.assertCurrent(generation,driver);
        this.state.phase = 'downloaded';
        this.state.progress = {...this.state.progress,percent:100};
        return this.snapshot();
      } catch (error) {
        this.assertCurrent(generation,driver);
        this.state.phase = 'error';
        this.state.error = publicSoftwareUpdateError(error?.code === 'ERR_UPDATER_CHECKSUM_MISMATCH' ? softwareUpdateError('UPDATE_INTEGRITY_FAILED') : error,'UPDATE_DOWNLOAD_FAILED');
        this.driver = null;
        stopDriver(driver);
        throw softwareUpdateError(this.state.error.code);
      } finally {
        if (this.downloadFlight?.generation === generation) this.downloadFlight = null;
      }
    });
    this.downloadFlight = {generation,promise};
    return promise;
  }

  async install() {
    if (this.state.phase !== 'downloaded' || !this.driver) throw softwareUpdateError('UPDATE_NOT_DOWNLOADED');
    const driver = this.driver, generation = this.generation;
    this.state.phase = 'installing';
    this.state.error = null;
    try {
      await this.installUpdate(driver);
      this.assertCurrent(generation,driver);
      return this.snapshot();
    } catch (error) {
      this.assertCurrent(generation,driver);
      this.state.phase = 'downloaded';
      this.state.error = publicSoftwareUpdateError(error,'UPDATE_INSTALL_FAILED');
      throw softwareUpdateError(this.state.error.code);
    }
  }

  dispose() { this.disposed = true; this.invalidate(); }
}
