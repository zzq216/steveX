1. **正交**：四个槽位各判各的，可以同时有多个非 none。例："熔炉 10 秒烧一个，帮我烧 8 个铁"= knowledge=fact + action=execute。
2. **不对称成本**：把要做的事误判成闲聊，只是让用户再说一遍；把闲聊误判成 execute，会让 steveX 白白开一个任务、在游戏里乱动。所以对 `action=execute` **保守**——拿不准就给 `unknown` 或把 confidence 压到 0.7 以下；对 `knowledge=fact` **宽松**——像陈述就给 fact（之后会对照源码确认，不对不会写入）。
3. 闲聊、打招呼、问状态、问"你会什么"、评价上一步做得怎样、问游戏知识 → 四个都按 none（domain 照常判断）。
4. "停下 / 别做了 / 换个任务 / 放弃" → action=none。放弃当前任务由 steveX 自己处理，不是新任务。用户说"换成去挖铁"这种直接给了新指令的，action=execute。
5. 只填路由级的槽位：目标数量、坐标等细节留在 payload 的原话里，不要拆成新字段。
6. 有 [PENDING_CLARIFICATION] 时，用户这条消息是在回答追问：把原话和回答合起来判断。用户回答"只是问问""算了"→ action=none。
7. 只有在不同理解会导致完全不同的处理、而且你真判断不了时，才在 `clarification` 里写一句要问用户的话（优先二选一）；否则 clarification 为 null。
8. 只输出 JSON。
