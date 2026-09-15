# MCP 日志读取与排障

## 动态日志

`server_search_logs` 和 `server_read_log` 允许普通日志在读取期间增长；`server_read_file` 对普通文件采用同样的有界读取。每次读取固定开始时的范围，不追着新增内容无限读取。

搜索结果的 `coverage` 提供 `snapshotSize`（规划时大小）、`observedSize`（读取时观察到的大小）、`scanStartByte`、`scanEndByte`（左闭右开）和 `sourceGrew`。增长时 `complete:false`，顶层 `truncated:true`、`truncationReasons` 包含 `sourceGrew`；不缓存这份变化中的内容。再次搜索可读取最新范围。

这是基于路径、类型、大小、修改时间和权限元数据的尽力读取，不提供事务快照，也不能证明增长过程中旧内容完全没有被改写。文件缩短、可观察到的同大小改写、权限或真实路径变化、短读仍返回 `SOURCE_CHANGED`。归档保持严格一致性检查；写入、上传、移动、删除的确认绑定与 stat/hash 前置条件不受影响。

只需要最新片段时使用 `server_read_file`：

```json
{
  "path": "/var/log/example/app.log",
  "tail": true,
  "maxBytes": 65536
}
```

以上仅列操作参数；实际 MCP 请求还需要当前环境的作用域字段和有效上下文。`tail:true` 不能与 `cursor` 同时使用；分页继续使用返回的 `nextCursor`。`size` 是本次开始读取时的文件大小，`observedSize` 和 `sourceGrew` 表示随后观察到的增长。

## ZIP / GZIP 轮转日志

搜索支持 `.zip`、`.gz`、`.gzip`，也会识别普通扩展名下的压缩魔数。`pattern:"*.log"` 同时匹配对应归档文件名。使用单个文件路径、日期文件名模式和一次多个 `queries` 可以减少重复传输。

```json
{
  "path": "/var/log/example",
  "pattern": "2026-01-02*.log.zip",
  "queries": ["request-example", "ERROR"],
  "maxDepth": 0,
  "maxFiles": 2,
  "maxScanBytes": 33554432,
  "maxExpandedBytes": 134217728
}
```

| 参数 | 含义与上限 |
| --- | --- |
| `maxScanBytes` | 远端输入字节；默认 16 MiB，兼容 `fileIds+contains` 默认为 4 MiB，最大 64 MiB。ZIP/GZIP 必须完整容纳压缩文件。 |
| `maxExpandedBytes` | 本次解压后总预算，也约束单个条目；默认是扫描预算的 4 倍，最大 128 MiB。单个条目不再额外限制为 32 MiB。 |
| `maxArchiveEntries` | 所有归档合计条目预算，默认及最大 128。 |
| 压缩比 | 仍限制为 100 倍；不能通过调大预算绕过。 |

压缩内容只在内存中处理。加密条目、嵌套归档、危险路径、符号链接等限制继续生效；这不表示支持任意压缩格式或无限大小日志。超过 128 MiB 的展开内容仍会被拒绝，应改选更小的轮转文件。

## 结果与错误的处理

- 先检查 `coverage`、`truncated`、`skipped` 和 `guidance`。`matchCount:0` 只能说明已扫描范围没有匹配。
- `ARCHIVE_INPUT_LIMIT`：压缩输入超过剩余扫描预算。指定单个文件并在 64 MiB 上限内调整 `maxScanBytes`。
- `LOG_ARCHIVE_ENTRY_TOO_LARGE` / `LOG_ARCHIVE_EXPANDED_LIMIT`：展开预算不足，在 128 MiB 上限内调整 `maxExpandedBytes`。增加输入预算不能替代展开预算。
- `SOURCE_CHANGED`：文件缩短、轮转、改写或归档变化。刷新发现结果；历史问题优先选择已完成的轮转归档。
- `SFTP_OPERATION_TIMEOUT`：达到 SFTP 会话总时限；`LOG_SCAN_TIMEOUT`：单个读取请求 30 秒没有响应。错误 `details` 提供阶段、时限以及已读取和请求字节数（进入读取阶段后），不含文件内容。
- 超时后若目录和 `server_stat` 正常，不必反复重连。先使用单个文件、缩小普通日志的尾部范围，并把多个关键词合并进一次 `queries`。归档需要完整输入，不能靠截断压缩包来查询。

SFTP 读取使用最多 16 个 30 KiB 请求构成的持续流水线，在途窗口从 512 KiB 降为 480 KiB；分块避开 SSH2 兼容端点的单次 READ 上限，减少库内拆包的串行往返。短读补齐、EOF、断连和关闭句柄均有本机 SSH 协议回归；120 秒会话总时限与 30 秒单请求无响应时限继续生效。慢块测试用于验证请求调度，不代表真实服务器的固定速度承诺。
