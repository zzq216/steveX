# 整理请求 {{requestId}}（胶囊库）

{{trigger}}

{{last}}

本回合只能调用这些 steveX 工具：{{tools}}。其他工具（如任务历史 `task_search` / `task_get`、`bt_inspect`、`bt_view`、`mod_query`）在整理回合会被拒绝。

## {{title}}

```text
{{library}}
```

每行：引用（种类）使用统计｜同名旧版本数｜下架状态｜（按范围整理时）为什么在范围里｜说明。统计是同名各版本的加总，只记录发生过什么，"尚无记录"表示没被用过，不表示没用。"跨实例"一段按调用时的实参分开记：在几种参数组合上成功过、哪些参数变过、哪些组合一次都没成功过（2026-11-13 之后的调用才有）。要看某个条目的契约、正文和统计明细，用 `capsule_get`。

请按下面的「胶囊库整理」{{scope}}，用 `capsule_retire` / `capsule_describe` 做你认为需要的改动（可以多次），最后用 `bt_curate_done` 结束（`requestId: "{{requestId}}"`）。什么都不改也要用 `bt_curate_done` 结束，并写明理由。

{{skill}}
