# 桌面 SQL 执行、事务与批量脚本

这是 2.0 稳定版的桌面人工操作功能。入口仍在 MySQL 工作区的 SQL 标签，不新增管理页面，也不扩展 Agent/MCP 权限。

## 操作方式

将表拖入 SQL 编辑区，会在该标签现有 SQL 的末尾追加 SELECT 查询，保留原有内容，不新建查询标签，也不会自动执行。执行中的编辑区不接受拖入。

工具栏沿用现有主题、紧凑按钮和目标环境标识。「执行」执行选中内容，没有选中时执行光标所在语句；下拉菜单另提供执行整个脚本。多语句结果逐条显示原始行号、耗时、影响行数及提交状态，查询结果继续用现有表格展示。提交和回滚按钮位置固定，无可操作事务时禁用。

| 模式 | 成功时 | 遇到错误时 |
| --- | --- | --- |
| 自动事务（默认） | 本次语句全部成功后自动提交，无需手动提交 | 自动回滚本次写入，后续语句跳过 |
| 逐条自动提交 | 每条写入成功后立即自动提交并生效 | 立即停止，之前已提交的更改不会撤销 |
| 手动事务 | 在同一 SQL 标签保留事务，用户点击提交或回滚 | 当前未提交事务回滚，包括该标签之前请求中的未提交修改 |

手动模式支持 `BEGIN`、`START TRANSACTION`、`COMMIT`、`ROLLBACK`，也可直接执行查询或增删改，由应用自动开启事务。事务控制语句不能在另外两种模式中使用。不支持嵌套事务。

每个 SQL 标签使用独立的物理连接；切换标签或「返回详情」保留当前事务。其他标签、表预览、表格编辑和 Agent 查询不会共用该事务；是否能读到其他连接后来提交的数据仍遵守服务器隔离级别。需要查看未提交修改时，在原标签继续查询。

生产环境写入按本次执行批次确认一次；无 WHERE 的 UPDATE / DELETE 在所有环境下均要求确认。确认展示实际项目、环境、数据库及即将执行的 SQL；后端保存精确脚本与短时执行计划，界面不能在确认后替换 SQL。这里的检查不能判断 WHERE 是否符合业务意图，实际影响行数以数据库执行结果为准。

## 首版支持范围

- 策略允许的 SELECT、EXPLAIN SELECT；SHOW TABLES、SHOW COLUMNS、SHOW INDEX、SHOW CREATE TABLE、DESCRIBE，限定当前插件数据库的基础表。
- 单表 INSERT VALUES、UPDATE、DELETE。数据库账号须具备实际操作所需权限，应用不会自动授权。
- 单次最多 100 条语句、256 KiB。脚本在任何业务语句执行前完整解析；字符串和注释中的分号不会被错误拆分。
- 每条查询最多返回 1000 行，遵守插件更低的行数和字节限制；整批结果最多 4 MiB，每条执行超时不超过插件设置与 30 秒中的较小值。
- 每个窗口、每个插件最多 6 个 SQL 会话，应用最多 24 个。执行计划有效期 2 分钟；SQL 会话闲置超过 5 分钟自动回滚未提交事务并释放连接。

不支持 DDL（建表、改表、删表、TRUNCATE）、跨库、视图、存储过程或自定义函数、账号授权、SET、变量、文件读写、SAVEPOINT、DELIMITER、多表写入、写入子查询、INSERT SELECT、INSERT IGNORE 和 ON DUPLICATE KEY UPDATE。函数采用已审核纯函数名单；无法识别的语法明确拒绝。为避免不同 SQL 模式对转义产生歧义，首版拒绝字符串中的反斜杠转义，可用标准重复引号表示引号。

写入只接受严格 SQL 模式下的 InnoDB 基础表。事务内获取元数据锁并复查表类型；需要能确认直接授予的 TRIGGER 权限以完整核对触发器。UPDATE / DELETE 还需要读取 `information_schema.INNODB_FOREIGN` 的 PROCESS 元数据权限，以排除相关入向级联外键。角色间接授予的 TRIGGER 权限暂不作为可见性证明。相关触发器、级联写入、非事务引擎或无法核实的元数据都会被拒绝，并说明原因。不要仅为使用该功能扩大生产账号权限，可以由数据库管理员评估或继续采用已有表格编辑入口。

执行受阻时，结果区的诊断详情区分元数据不可见、实际读写权限不足、表不可见、非基础表、非事务引擎、相关触发器或级联外键，以及严格模式未启用，并给出对应的核对建议。无法读取元数据不等于已经发现触发器或级联关系；提示也不会把账号权限不足描述为连接失败。本版沿用现有执行条件，不自动授予权限、不提供授权 SQL，也不扩大语法支持范围。

诊断原因由后端固定枚举传递，界面使用对应的固定说明；展示和复制诊断时不包含数据库驱动返回的 SQL、参数、账号或地址。无论诊断原因如何，当前事务的回滚或待核实状态仍单独展示。

## 结果与生命周期

结果明确区分已提交、未提交、已回滚和待核实。自动事务模式下，前面的语句执行成功但随后被回滚时，不会显示为已保存；逐条自动提交模式保留先前成功提交的结果。手动事务及批量结果使用只读结果表格，防止用户误把独立的表格编辑保存当作当前 SQL 事务的一部分；单条 SELECT 且没有活动事务时仍可使用原有表格编辑功能。

活动事务的状态条可以展开，查看本事务跨多次执行的成功操作摘要，包括操作类型、表名及影响行次；后续查询不会清除之前的待提交写入。总数累计整个事务，仅显示最近 100 条操作、每条最多 20 个表名，截断时明确提示。影响行次是各条语句影响行数的累计，同一行被反复修改会重复计数。仅查询的事务明确显示没有写入；BEGIN / COMMIT / ROLLBACK 不计入操作总数。提交或回滚后清除摘要，新事务重新计数，各 SQL 标签独立。

状态条同时显示事务持续时间和距离空闲自动回滚的剩余时间，少于 60 秒时加强提醒。执行过程中暂停空闲计时；准备或完成执行会更新后端空闲时间，查看状态和切换标签不会延期。倒计时依据后端快照和客户端单调时钟推进，归零只显示「正在确认事务状态」，收到后端确认后才显示已回滚。连接中断、提交结果待核实时保留已有成功操作摘要并停止显示回滚倒计时，避免误判最终结果。

停止只关闭当前 SQL 标签的连接，不断开整个插件或其他标签。写入/提交期间断线或停止，若无法确认结果，显示待核实并禁止直接重试；已提交的语句不能通过停止撤销。使用新的查询标签核实后，再关闭原标签。

关闭含活动事务或待核实结果的标签、关闭工作区、主动断开及应用退出均有保护。退出或释放连接会回滚尚未提交的数据库事务，但不能撤销已提交的写入。网络异常、进程崩溃仍可能中断连接，应用不会把缺少提交应答误报为成功或已回滚。

SQL 与结果仅保留在内存，事务摘要也只保留在当前会话内存，不保存 SQL 正文或值，不构成持久历史。操作记录保存用户、目标数据库、语句数量、影响行数、事务模式、结果、错误代码及 SQL 指纹，不保存 SQL 正文、参数或返回行。桌面新增 `mysqlSql` 一个 preload API（prepare / execute / status / stop / release），仅受信桌面主框架可用，按窗口、项目、环境、插件、配置版本和标签绑定；状态结果的可选 `transactionSummary` 提供事务 ID、累计数量、有限操作摘要及后端时钟与空闲期限。Agent/MCP 仍仅允许固定数据库的单条只读 SELECT / EXPLAIN SELECT；当前为 115 个桌面 API、40 个 MCP 工具。

## 设计参考

- [DBeaver：SQL 执行](https://dbeaver.com/docs/dbeaver/SQL-Execution/)：当前语句、选中内容和整个脚本的入口。
- [DBeaver：自动和手动提交](https://dbeaver.com/docs/dbeaver/Auto-and-Manual-Commit-Modes/)：事务模式、待提交状态及提交/回滚。
- [MySQL Workbench：SQL 工具栏](https://dev.mysql.com/doc/workbench/en/wb-sql-editor-toolbar.html)：固定的执行、停止与事务按钮。本应用按标签隔离连接，不沿用多个查询标签共享事务的行为。
- [MySQL：隐式提交](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html)和[非事务表](https://dev.mysql.com/doc/refman/8.4/en/nontransactional-tables.html)：首版不把 DDL 或非事务表纳入可回滚的承诺。

## 验证

普通测试使用合成数据、内存夹具及本机回环 MySQL 协议服务，不连接真实基础设施。

```sh
node --test test/mysql-sql-script-policy.test.mjs test/mysql-sql-connections.test.mjs test/mysql-sql-execution.test.mjs test/mysql-sql-ipc.test.mjs test/mysql-sql-diagnostics.test.mjs test/renderer-mysql-transaction-summary.test.mjs test/renderer-diagnostic-model.test.mjs
corepack pnpm run check
corepack pnpm test
corepack pnpm run test:ui
corepack pnpm run test:ui:database
corepack pnpm run test:ui:mysql-edit
```

打包后继续运行 `scripts/verify-package.mjs`、`scripts/packaged-mcp-smoke.mjs`、`scripts/packaged-ui-smoke.cjs`；正式包探针覆盖真实 preload、隔离连接、生产确认、事务提交/回滚、跨请求摘要及 MCP 只读边界。数据库 UI 回归覆盖摘要展开、多标签隔离、倒计时、待核实状态和权限诊断。
