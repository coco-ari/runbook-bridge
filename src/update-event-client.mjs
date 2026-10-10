// 连接地址和认证头只来自主进程已验证的来源，不接受事件中的地址或指令。
export async function readUpdateEvents({url,token,signal,onChange,fetchImpl = globalThis.fetch,idleMs = 45_000}) {
  const timeout = new AbortController();
  let timer;
  const touch = () => { clearTimeout(timer); timer = setTimeout(() => timeout.abort(),idleMs); timer.unref?.(); };
  touch();
  try {
    const response = await fetchImpl(url,{redirect:'error',signal:AbortSignal.any([signal,timeout.signal]),headers:{Accept:'text/event-stream',...(token ? {Authorization:`Bearer ${token}`} : {})}});
    if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
      await response.body?.cancel();
      throw Object.assign(new Error('推送连接不可用。'),{retryMs:[401,403,404,405].includes(response.status) ? 15 * 60_000 : undefined});
    }
    let buffer = '', event = '', data = '';
    const decoder = new TextDecoder('utf-8',{fatal:true});
    for await (const chunk of response.body) {
      if (signal.aborted) return;
      touch();
      buffer += decoder.decode(chunk,{stream:true});
      if (buffer.length > 64 * 1024) throw new Error('推送内容超限。');
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0,end).replace(/\r$/,''); buffer = buffer.slice(end+1);
        if (line.length > 4096) throw new Error('推送内容超限。');
        if (line === '') {
          if (event === 'change') {
            let value;
            try { value = JSON.parse(data); } catch { throw new Error('推送格式无效。'); }
            if (!value || Object.keys(value).length !== 1 || !Object.hasOwn(value,'revision') || !(value.revision === null || typeof value.revision === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value.revision))) throw new Error('推送格式无效。');
            onChange(value.revision);
          }
          event = ''; data = '';
        } else if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) { data += line.slice(5).trimStart(); if (data.length > 4096) throw new Error('推送内容超限。'); }
      }
    }
  } finally { clearTimeout(timer); timeout.abort(); }
}

export function subscribeUpdateEvents(options) {
  let disposed = false, controller, timer, failures = 0;
  const connect = async () => {
    if (disposed) return;
    controller = new AbortController();
    let delay;
    try {
      await readUpdateEvents({...options,signal:controller.signal,onChange:revision => { failures = 0; if (!disposed) options.onChange(revision); }});
    } catch (error) { delay = error.retryMs; }
    if (disposed) return;
    delay ??= Math.min(60_000,1000 * 2 ** Math.min(failures++,6)) + Math.floor(Math.random()*1000);
    timer = setTimeout(connect,delay); timer.unref?.();
  };
  void connect();
  return {dispose() { disposed = true; clearTimeout(timer); controller?.abort(); }};
}
