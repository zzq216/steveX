# 整理请求 {{requestId}}（胶囊库）

{{trigger}}

{{last}}

## 胶囊库

```text
{{library}}
```

每行：引用（种类）使用统计｜同名旧版本数｜下架状态｜说明。统计是同名各版本的加总，只记录发生过什么，"尚无记录"表示没被用过，不表示没用。要看某个条目的契约、正文和统计明细，用 `capsule_get`。

请按下面的「胶囊库整理」看一遍库，用 `capsule_retire` / `capsule_describe` 做你认为需要的改动（可以多次），最后用 `bt_curate_done` 结束（`requestId: "{{requestId}}"`）。什么都不改也要用 `bt_curate_done` 结束，并写明理由。

{{skill}}
