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

## 普通文本的字节分页

server_read_file、server_read_log 和 server_read_config 返回完整 UTF-8 字符，实际正文可能少于 maxBytes；请使用返回的 nextCursor，不要用原预算自行计算下一页位置。普通文件和日志的原始 READ 不扩大到请求预算之外，正文解码后也受预算限制；配置仍按原有 1 MiB 上限读取并校验，然后在内存中分页。

当预算连下一个完整字符都无法容纳时，返回 INVALID_ARGUMENT，details.field 为 maxBytes，minimumBytes 和 suggestedValue 给出可用预算。例如 A中B 用 2 字节预算先返回 A 和 nextCursor:1，随后同一 cursor:1 会提示至少容纳 3 字节；增大预算后可以继续。非空成功页不会产生不前进的游标。这里的数字字节游标允许调整 maxBytes，和 server_search_logs 必须保持参数一致的不透明游标不同。

尾读窗口若从多字节字符中间开始，会向文件末尾方向跳过开头残缺字符，并返回实际 startByte；窗口过小则提示增加预算。非 UTF-8 输入保持替换字符语义，返回预算仍生效；手工把普通文件或日志的字节 cursor 放到字符中间可能得到替换字符。配置读取拥有完整文本，可以明确拒绝这种 cursor。有效 UTF-8 从文件开头按工具返回的游标读取不会因分页产生替换字符。

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
| `maxScanBytes` | 远端输入字节；默认 4 MiB，最大 64 MiB。ZIP/GZIP 必须完整容纳压缩文件。 |
| `maxExpandedBytes` | 本次解压后总预算，也约束单个条目；默认是扫描预算的 4 倍，最大 128 MiB。单个条目不再额外限制为 32 MiB。 |
| `maxArchiveEntries` | 所有归档合计条目预算，默认及最大 128。 |
| `maxResultBytes` | `matches` 与 `contexts` 的 UTF-8 JSON 正文预算，默认 32 KiB，最小 16 KiB，最大 2 MiB；覆盖范围等元数据另计。 |
| 压缩比 | 仍限制为 100 倍；不能通过调大预算绕过。 |

压缩内容只在内存中处理。加密条目、嵌套归档、危险路径、符号链接等限制继续生效；这不表示支持任意压缩格式或无限大小日志。超过 128 MiB 的展开内容仍会被拒绝，应改选更小的轮转文件。

## 结果与错误的处理

- 先检查 `coverage`、`truncated`、`skipped` 和 `guidance`。`matchCount:0` 只能说明已扫描范围没有匹配。
- `ARCHIVE_INPUT_LIMIT`：单个压缩文件超过整页输入预算。只超过本页剩余预算的文件会保留到 `nextCursor`，不会因此永久跳过。
- `LOG_ARCHIVE_ENTRY_TOO_LARGE` / `LOG_ARCHIVE_EXPANDED_LIMIT`：单个归档在完整页预算下仍无法展开，在 128 MiB 上限内调整 `maxExpandedBytes`。只因前面的文件消耗了展开预算而失败的归档会留到下一页；条目数预算同样按页续查。增加输入预算不能替代展开预算。
- 预算错误的 `skipped[].retryable` 表示能否在上限内调整预算；为 `true` 时 `suggestedArguments` 给出单文件新搜索的参数片段。保留原查询条件，移除旧 `cursor`、`fileIds`、`sourceId`，再合并建议的 `path` 和预算。损坏、危险条目和压缩比限制不会因调大预算而放行。
- `SOURCE_CHANGED`：文件缩短、轮转、改写或归档变化。刷新发现结果；历史问题优先选择已完成的轮转归档。
- `SFTP_OPERATION_TIMEOUT`：达到 SFTP 会话总时限；`LOG_SCAN_TIMEOUT`：单个读取请求 30 秒没有响应。错误 `details` 提供阶段、时限以及已读取和请求字节数（进入读取阶段后），不含文件内容。
- 超时后若目录和 `server_stat` 正常，不必反复重连。先使用单个文件、缩小普通日志的尾部范围，并把多个关键词合并进一次 `queries`。归档需要完整输入，不能靠截断压缩包来查询。

SFTP 读取使用最多 16 个 30 KiB 请求构成的持续流水线，在途窗口从 512 KiB 降为 480 KiB；分块避开 SSH2 兼容端点的单次 READ 上限，减少库内拆包的串行往返。短读补齐、EOF、断连和关闭句柄均有本机 SSH 协议回归；普通读取保留 120 秒会话总时限与 30 秒单请求无响应时限；日志搜索额外使用下述更短的单页预算。慢块测试用于验证请求调度，不代表真实服务器的固定速度承诺。

## 续查和证据完整性

每次请求是一页，扫描/展开字节和文件/匹配数上限都按页计算。把 `nextCursor` 原样放进下一次请求的 `cursor`，其余参数（包括 `refresh`）保持一致。游标绑定项目、环境、插件版本、MCP 会话、SSH 连接代次和搜索条件；保存最多 5 分钟，淘汰或过期后从原范围重新搜索。游标只保留有界文件元数据，最多 128 个/8 MiB，不保存正文或授权。

普通文件先搜尾部，续查按完整行向前移动；同一窗口匹配分页不会重新发现目录。ZIP/GZIP 的匹配可以跨成员分页，仍需完整读取压缩输入。稳定输入在内存中最多缓存 64 MiB/5 分钟，命中后仍检查身份；续查可能再次解压，但省去远端传输。大于读取窗口的超长行会在 `skipped` 标明，不能声称完整。

| 字段 | 如何使用 |
| --- | --- |
| `status:complete` | 已完成发现范围内的固定读取范围；输出文本仍可能裁剪，另看 `truncated`。 |
| `status:partial` | 还有页、目录或无法读取的范围；继续检查 `nextCursor`、`remainingDirectories` 和各页 `skipped`。 |
| `conclusion:matches` | 当前续查链已有命中；`progress.matchedSoFar` 是累计返回数。 |
| `conclusion:no_match` | 完整搜索范围内没有匹配。 |
| `conclusion:inconclusive` | 暂未命中且证据不完整，不能据此排除问题。 |
| `coverage.complete` | 当前文件窗口是否覆盖全文件，与整个续查链的完成状态不同。 |
| `scanStartByte/scanEndByte` | 真正搜索的字节范围；`readStartByte` 还包括被跳过的不完整首行。 |
| `scannedBytes` | 本页计费输入范围，包括缓存输入、探测和失败读取的预留范围。 |
| `remoteBytesRead` | 已成功返回的远端输入字节；失败请求可能已传输部分内容，故不是线速流量计。 |

多文件搜索遇到单个文件消失或改写可保留其他文件结果；真实路径越界或安全检查失败仍拒绝。未发现的目录最多返回 32 个导航建议，不会自动扩大搜索范围。每页远程会话预算为 20 秒，覆盖 SFTP 建连、目录发现和读取，超时中止当前通道并等待有界清理，排队时间另外受队列上限约束。已确定文件清单时保留已完成的匹配、coverage 和 nextCursor；当前未完成文件在下一页重新验证读取，不把部分传输字节算作完整覆盖。返回 interruption.code（LOG_SEARCH_TIMEOUT、LOG_SCAN_TIMEOUT 或 SFTP_OPERATION_TIMEOUT）及 truncationReasons:timeBudget。未完成文件发现时仍返回带 phase:discovery 的错误，不生成虚假游标。若同一文件再次超时，应缩小范围后发起新搜索，避免无限续查。

目录最多缓存 15 秒，按作用域、插件版本、连接代次和目录身份隔离。每次仍核对目录类型/真实路径，新搜索复核缓存文件元数据。SFTP 修改时间精度有限，无法凭元数据证明目录或文件从未变化；要读取最新内容，移除游标并使用 `refresh:true`，重新发现目录和读取文件。

## 正文分页与截断

结果先返回 `nextCursor`、`status`、`conclusion`、`coverage`、`skipped` 等控制信息，再返回 `matches` 和 `contexts`，方便 Agent 先判断范围。`resultBytes` 是两个正文数组的实际 UTF-8 JSON 字节数，不含其余元数据。默认每页 32 KiB，旧的匹配数上限仍是上限，正文预算可能使实际返回数更少。

按字节分页只推进已经返回的匹配数，普通日志和 ZIP/GZIP 跨成员续查均保留剩余命中。`truncationReasons:outputBytes` 表示输出受限；有 `nextCursor` 时继续。单条匹配加上下文仍超过整页预算时保留匹配本身，省略该条上下文并标记 `contextOmitted`；若匹配本身也过大，允许该单条超过正文预算以保证游标推进。需要完整上下文时增大 `maxResultBytes` 并从对应文件发起新搜索。单行原有 4 KiB 文本上限保持不变。

正文预算不保证 Codex 的整个并行调用输出不会截断；避免一次打印多页完整日志。续查参数仍须完全相同，调整 `maxResultBytes` 时应移除旧游标重新搜索。

## 参数及下载体验

新工具 Schema 只展示 `maxMatches`，后端保留 `maxLines` 旧别名，两者不可同时传入。数字超限返回 `details.field/minimum/maximum/suggestedValue`，可直接修正后重试。`LOG_CURSOR_MISMATCH` 表示参数或连接变化；`LOG_CURSOR_EXPIRED` 表示游标过期或淘汰。

单插件日志搜索串行，全局最多 2 个；一般 Server 读取全局最多 4 个、单插件最多 2 个。`READ_BUSY` / `LOG_SEARCH_BUSY` 返回排队阶段与建议重试间隔，排队最多 10 秒，不在队列中额外访问服务器。

下载仍保存到工作台管理的本地目录。单服务器最多 1 个下载，全局最多 2 个，使用 16 × 30 KiB 传输窗口；有进度时允许继续，总时限 10 分钟，无进度时限 30 秒。完成后复核源身份和本地大小，再提升临时文件。超时返回纯数值进度并清理临时文件，不代表支持断点续传。


## 推荐调用示例

首次搜索优先省略预算参数，按准确路径或日期范围合并关键词。下面仅列操作参数；实际调用必须带当前作用域和 contextToken：

```json
{
  "path": "/var/log/example",
  "pattern": "app-2026-01-01*.log*",
  "queries": ["request-example", "ERROR"],
  "matchMode": "all",
  "maxDepth": 1
}
```

- 有 nextCursor：保持上述参数完全一致，仅增加 cursor；部分页零匹配不是没有证据。
- INVALID_ARGUMENT：按照 details.field、minimum、maximum、suggestedValue 调整；调整参数时移除旧 cursor。
- maxScanBytes：默认 4194304，允许 65536–67108864。只有确需扩大覆盖范围或容纳归档输入时才增加。
- maxResultBytes：默认 32768，允许 16384–2097152。不要为了减少输出而传 10000；可减少 maxMatches 和上下文行数。
- 归档超限：检查 skipped.requiredExpandedBytes 和 suggestedArguments。已知大小超过硬上限时 retryable:false；流式解压仅知道已观察到的字节下限，建议值不保证能容纳整个归档。
- 只看最新片段：使用 server_read_file 的 tail:true 和 maxBytes:65536，避免启动大范围搜索。
