# hi-log AI 集成指南

hi-log 提供 **MCP Server**,AI 助手(Claude Code 等)可直接分析日志并在 GUI 中留下标记/固定,实现「AI 分析 → 人工确认」闭环。

## 启动

```bash
hi-log mcp        # stdio MCP Server(独立进程,不依赖 GUI)
```

在 Claude Code 里接入(settings 的 mcpServers 配置,或用 `claude mcp add`):

```bash
claude mcp add hi-log -- /path/to/hi-log mcp
```

MCP 客户端握手后,`initialize` 返回 **instructions** 会引导模型使用方法(方法/流程/行号约定等)。

## 工具一览

| 工具 | 说明 |
| --- | --- |
| `open_file` | 打开日志(可打开**多个**,互不影响),返回 `file_id`(即路径) |
| `search` | 全文检索指定文件,返回命中行号(可带内容/正则/大小写) |
| `get_lines` | 按行号批量取内容(1-based) |
| `mark_line` | 打标记:颜色(0-7)+ 备注(GUI 中显示为注释行) |
| `list_marks` | 列出指定文件的全部标记 |
| `pin_line` | 固定书签:分组 + 名称 |
| `list_pins` | 列出指定文件的全部固定 |

## 多文件

**每个工具用 `file_id` 参数指定文件**(`open_file` 返回的路径字符串):

```json
{"name":"open_file","arguments":{"path":"/logs/app.log"}}          → file_id = "/logs/app.log"
{"name":"search","arguments":{"query":"OOM","file_id":"/logs/app.log"}}
{"name":"mark_line","arguments":{"file_id":"/logs/app.log","line_no":1048576,"color":2,"note":"疑似内存泄漏"}}
```

- `file_id` **缺省**时作用于**最近打开**的文件(方便单文件场景少写参数)
- 多文件操作**建议显式传 file_id**,避免混淆

## 推荐工作流

1. `open_file` 打开一个或多个日志 → 记下 `file_id`
2. `search` 找异常(如 `FATAL EXCEPTION`、`Caused by`、`timeout`),`get_lines` 看上下文
3. 关键行 → `mark_line`(颜色+备注,**备注写清结论/原因**)+ `pin_line` 固定书签
4. 人在 GUI 中点击标记/注释即可定位确认,标记自动持久化(SQLite,重开仍在)

## 行号约定

- 行号为 **1-based**(第 1 行 = 1)
- `mark_line` 同文件同行重复调用 = 更新(颜色/备注)
- 颜色:0-7 色板,默认 4(蓝);建议错误用 2(红)/ 4(蓝)等区分严重级

## 与 GUI 联动

- 标记/固定写入与 GUI **同一个 SQLite**(`app_data_dir/hi-log.db`),GUI 侧打开文件即显示
- 完成后在 GUI 中刷新/重新打开文件,即可看到 AI 留下的标记与注释行
