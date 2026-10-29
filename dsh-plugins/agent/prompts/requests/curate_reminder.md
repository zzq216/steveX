整理请求 {{requestId}} 还没有结束。本次整理已经做了 {{changes}} 处改动。

还要改就继续用 `capsule_retire` / `capsule_describe`；整理完了用 `bt_curate_done` 结束（`requestId: "{{requestId}}"`），`reason` 写改了什么、为什么，或者为什么不需要改。

这一回合再结束时还没有 `bt_curate_done`，整理就按放弃关闭（已经做的改动保留）。
