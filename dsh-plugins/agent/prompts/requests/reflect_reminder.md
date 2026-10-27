复盘请求 {{requestId}} 还没有结束。本次复盘已经存下：{{saved}}。

还要存就继续用 `capsule_save`；复盘完了用 `bt_reflect_done` 结束（`requestId: "{{requestId}}"`），`summary` 写存了什么、为什么，或者为什么没有值得存的。

这一回合再结束时还没有 `bt_reflect_done`，复盘就按放弃关闭（已经存进库的胶囊保留）。
